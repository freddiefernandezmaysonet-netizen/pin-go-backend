import assert from "node:assert/strict";
import test from "node:test";

import {
  PinAIActionProposalStatus,
  PinAIActionProposalType,
  ReservationModificationStatus,
} from "@prisma/client";

import {
  PinAIActionBroker,
} from "./action-broker.service.js";
import {
  PinAIReservationModificationActionAdapter,
  type PinAIReservationModificationPreview,
} from "./reservation-modification-action-adapter.service.js";
import {
  PinAIActionProposalRuntimeToolExecutor,
} from "../runtime/action-proposal-tool-executor.js";
import {
  createConversationMemory,
} from "../runtime/conversation-memory.js";
import type {
  PinAIRuntimeRequest,
} from "../runtime/contracts.js";

const NOW =
  new Date("2026-09-26T14:00:00.000Z");
const GUEST_TOKEN =
  "12345678-1234-1234-1234-123456789abc";
const PROPOSAL_ID =
  "proposal-12345678";
const CONFIRMATION_TOKEN =
  "confirmation-token-private-123456789012345";
const PROPOSAL_FINGERPRINT =
  "b".repeat(64);
const INITIAL_PREVIEW_FINGERPRINT =
  "a".repeat(64);

const request: PinAIRuntimeRequest = {
  context: {
    organizationId:
      "organization-a",
    propertyId:
      "property-a",
    reservationId:
      "reservation-a",
    guestId:
      "reservation-guest",
    currentLocalDateTime:
      "2026-09-26T10:00:00-04:00",
    preferredLanguage: "es",
  },
  conversation: [
    {
      role: "guest",
      content:
        "Quiero extender mi estadía hasta el 5 de octubre.",
    },
  ],
};

type Scenario =
  | "NO_PAYMENT"
  | "PAYMENT_REQUIRED"
  | "HOST_APPROVAL";

function makePreview(
  input: Readonly<{
    financialAction: string;
    amountDifferenceCents: number;
    proposedTotalAmountCents: number;
    fingerprint?: string;
  }>,
): PinAIReservationModificationPreview {
  return {
    changes: {
      hasChanges: true,
    },
    property: {
      timezone:
        "America/Puerto_Rico",
    },
    reservation: {
      version:
        new Date(
          "2026-09-26T13:55:00.000Z",
        ),
      currency: "usd",
      current: {
        checkIn:
          new Date(
            "2026-10-01T20:00:00.000Z",
          ),
        checkOut:
          new Date(
            "2026-10-04T15:00:00.000Z",
          ),
        adults: 2,
        children: 0,
        selectedAmenityIds: [],
      },
      proposed: {
        checkIn:
          new Date(
            "2026-10-01T20:00:00.000Z",
          ),
        checkOut:
          new Date(
            "2026-10-05T15:00:00.000Z",
          ),
        adults: 2,
        children: 0,
        selectedAmenityIds: [],
      },
    },
    pricing: {
      currentTotalAmountCents:
        35_335,
      proposed: {
        totalAmountCents:
          input.proposedTotalAmountCents,
      },
      amountDifferenceCents:
        input.amountDifferenceCents,
      financialAction:
        input.financialAction,
      reductionPolicy:
        input.financialAction ===
        "REDUCTION_REVIEW_REQUIRED"
          ? {
              outcome:
                "HOST_APPROVAL_REQUIRED",
              requiresHostApproval:
                true,
            }
          : {
              outcome:
                "NOT_APPLICABLE",
              requiresHostApproval:
                false,
            },
    },
    previewFingerprint:
      input.fingerprint ??
      INITIAL_PREVIEW_FINGERPRINT,
  };
}

function scenarioPreview(
  scenario: Scenario,
) {
  switch (scenario) {
    case "NO_PAYMENT":
      return makePreview({
        financialAction:
          "NO_PAYMENT_REQUIRED",
        amountDifferenceCents: 0,
        proposedTotalAmountCents:
          35_335,
      });
    case "HOST_APPROVAL":
      return makePreview({
        financialAction:
          "REDUCTION_REVIEW_REQUIRED",
        amountDifferenceCents:
          -5_000,
        proposedTotalAmountCents:
          30_335,
      });
    case "PAYMENT_REQUIRED":
    default:
      return makePreview({
        financialAction:
          "ADDITIONAL_PAYMENT_REQUIRED",
        amountDifferenceCents:
          16_850,
        proposedTotalAmountCents:
          52_185,
      });
  }
}

function createHarness(
  scenario: Scenario,
) {
  let currentPreview =
    scenarioPreview(scenario);
  let proposal:
    any = null;
  let confirmedToken:
    string | null = null;
  let confirmModificationCalls = 0;
  let applyCalls = 0;
  let checkoutCalls = 0;
  let supersedeCalls = 0;
  let confirmModificationInput:
    Record<string, unknown> |
    null = null;

  const fakePrisma = {
    pinAIActionProposal: {
      async findFirst() {
        return proposal;
      },
    },
    reservation: {},
  };

  const adapter =
    new PinAIReservationModificationActionAdapter({
      prisma:
        fakePrisma as never,
      async getPreview() {
        return currentPreview;
      },
      async createProposal(input) {
        proposal = {
          id: PROPOSAL_ID,
          organizationId:
            "organization-a",
          propertyId:
            "property-a",
          reservationId:
            "reservation-a",
          actionType:
            PinAIActionProposalType
              .RESERVATION_MODIFICATION,
          status:
            PinAIActionProposalStatus
              .PENDING_CONFIRMATION,
          proposalFingerprint:
            PROPOSAL_FINGERPRINT,
          termsSnapshot:
            input.termsSnapshot,
          expiresAt:
            new Date(
              input.expiresAt,
            ),
          confirmedAt: null,
          supersededAt: null,
          reservation: {
            id:
              "reservation-a",
            propertyId:
              "property-a",
            guestTokenExpiresAt:
              new Date(
                NOW.getTime() +
                  3 *
                    60 *
                    60 *
                    1000,
              ),
            property: {
              organizationId:
                "organization-a",
            },
          },
        };

        return {
          confirmationToken:
            CONFIRMATION_TOKEN,
          proposal: {
            id: PROPOSAL_ID,
            expiresAt:
              new Date(
                input.expiresAt,
              ),
          },
        };
      },
      async supersedeProposal() {
        supersedeCalls += 1;
        if (proposal) {
          proposal.status =
            PinAIActionProposalStatus
              .SUPERSEDED;
          proposal.supersededAt =
            new Date(NOW);
        }
        return {
          ok: true,
        };
      },
      async confirmModification(
        input,
      ) {
        confirmModificationCalls +=
          1;
        confirmModificationInput = {
          ...input,
        };

        const status =
          scenario ===
          "NO_PAYMENT"
            ? ReservationModificationStatus
                .APPLYING
            : scenario ===
                "HOST_APPROVAL"
              ? ReservationModificationStatus
                  .HOST_APPROVAL_REQUIRED
              : ReservationModificationStatus
                  .AWAITING_PAYMENT;

        return {
          modification: {
            id:
              "modification-12345678",
            status,
          },
        };
      },
      async createCheckout() {
        checkoutCalls += 1;
        return {
          checkoutUrl:
            "https://checkout.stripe.test/session",
          checkoutExpiresAt:
            new Date(
              NOW.getTime() +
                80 *
                  60 *
                  1000,
            ),
        };
      },
      async applyModification() {
        applyCalls += 1;
        return {
          modification: {
            id:
              "modification-12345678",
            status:
              ReservationModificationStatus
                .APPLIED,
          },
        };
      },
      now: () =>
        new Date(NOW),
    });

  const broker =
    new PinAIActionBroker({
      prisma:
        fakePrisma as never,
      reservationModification:
        adapter,
      async confirmProposal(input) {
        confirmedToken =
          String(
            input.confirmationToken ??
            "",
          );

        assert.equal(
          confirmedToken,
          CONFIRMATION_TOKEN,
        );
        assert.ok(proposal);
        assert.equal(
          proposal.status,
          PinAIActionProposalStatus
            .PENDING_CONFIRMATION,
        );

        proposal.status =
          PinAIActionProposalStatus
            .CONFIRMED;
        proposal.confirmedAt =
          new Date(
            NOW.getTime() +
              60_000,
          );

        return {
          proposalConfirmed:
            true as const,
          actionExecuted:
            false as const,
          proposal: {
            id:
              proposal.id,
            actionType:
              proposal.actionType,
            expiresAt:
              proposal.expiresAt,
          },
        };
      },
      now: () =>
        new Date(
          NOW.getTime() +
            60_000,
        ),
    } as never);

  const runtimeExecutor =
    new PinAIActionProposalRuntimeToolExecutor({
      delegate: {
        async execute() {
          return {
            decision:
              "READ_DELEGATED",
          };
        },
      },
      enabled: true,
      guestToken:
        GUEST_TOKEN,
      async getModificationOptions() {
        return {
          reservation: {
            current: {
              adults: 2,
              children: 0,
              selectedAmenityIds: [],
            },
          },
          property: {
            timezone:
              "America/Puerto_Rico",
            checkInTime:
              "16:00",
            checkOutTime:
              "11:00",
          },
        };
      },
      prepareReservationModification:
        (input) =>
          broker
            .prepareReservationModification(
              input,
            ),
    });

  async function prepareThroughRuntime() {
    const modelSafe =
      await runtimeExecutor
        .execute(
          "prepare_reservation_modification",
          {
            proposedCheckInDate:
              "2026-10-01",
            proposedCheckOutDate:
              "2026-10-05",
          },
          request,
          createConversationMemory(
            request,
          ),
        );

    const privateProposal =
      runtimeExecutor
        .getPrivateActionProposal();

    assert.ok(
      privateProposal,
    );

    return {
      modelSafe,
      privateProposal,
    };
  }

  async function confirmThroughBroker() {
    const privateProposal =
      runtimeExecutor
        .getPrivateActionProposal();

    assert.ok(
      privateProposal,
    );

    return broker
      .confirmAndExecute({
        guestToken:
          GUEST_TOKEN,
        proposalId:
          privateProposal
            .privateConfirmation
            .proposalId,
        confirmationToken:
          privateProposal
            .privateConfirmation
            .confirmationToken,
      });
  }

  return {
    prepareThroughRuntime,
    confirmThroughBroker,
    setPreview(
      next:
        PinAIReservationModificationPreview,
    ) {
      currentPreview =
        next;
    },
    getProposal: () =>
      proposal,
    getConfirmedToken: () =>
      confirmedToken,
    getConfirmModificationCalls:
      () =>
        confirmModificationCalls,
    getConfirmModificationInput:
      () =>
        confirmModificationInput,
    getApplyCalls: () =>
      applyCalls,
    getCheckoutCalls: () =>
      checkoutCalls,
    getSupersedeCalls: () =>
      supersedeCalls,
  };
}

test(
  "E2E no-payment change: proposal-only runtime -> guest confirmation -> canonical apply -> EXECUTED",
  async () => {
    const harness =
      createHarness(
        "NO_PAYMENT",
      );

    const {
      modelSafe,
      privateProposal,
    } =
      await harness
        .prepareThroughRuntime();

    assert.equal(
      modelSafe.decision,
      "ACTION_PROPOSAL_PREPARED",
    );
    assert.equal(
      modelSafe.actionExecuted,
      false,
    );
    assert.equal(
      modelSafe.availabilityHeld,
      false,
    );
    assert.equal(
      JSON.stringify(
        modelSafe,
      ).includes(
        CONFIRMATION_TOKEN,
      ),
      false,
    );

    assert.equal(
      privateProposal
        .publicResult.quote
        .quoteExpiresAtLocal,
      "2026-09-26T11:00:00-04:00",
    );
    assert.equal(
      privateProposal
        .publicResult.quote
        .availabilityHeld,
      false,
    );

    const result =
      await harness
        .confirmThroughBroker();

    assert.equal(
      result.outcome,
      "EXECUTED",
    );
    assert.equal(
      result.actionExecuted,
      true,
    );
    assert.equal(
      result.modificationStatus,
      ReservationModificationStatus
        .APPLIED,
    );
    assert.equal(
      harness.getApplyCalls(),
      1,
    );
    assert.equal(
      harness.getCheckoutCalls(),
      0,
    );
    assert.equal(
      harness
        .getConfirmedToken(),
      CONFIRMATION_TOKEN,
    );

    const canonicalInput =
      harness
        .getConfirmModificationInput()!;
    assert.equal(
      canonicalInput
        .confirmationSource,
      "PIN_AI_GUEST_SERVICES",
    );
    assert.equal(
      canonicalInput
        .actionProposalId,
      PROPOSAL_ID,
    );
    assert.equal(
      canonicalInput
        .clientRequestId,
      `pin_ai_${PROPOSAL_ID}`,
    );
  },
);

test(
  "E2E paid extension: confirmed proposal returns WAITING_FOR_PAYMENT without claiming execution",
  async () => {
    const harness =
      createHarness(
        "PAYMENT_REQUIRED",
      );

    const {
      privateProposal,
    } =
      await harness
        .prepareThroughRuntime();

    const quoteExpiry =
      privateProposal
        .publicResult.quote
        .quoteExpiresAt;

    const result =
      await harness
        .confirmThroughBroker();

    assert.equal(
      result.outcome,
      "WAITING_FOR_PAYMENT",
    );
    assert.equal(
      result.actionExecuted,
      false,
    );
    assert.equal(
      result.checkoutUrl,
      "https://checkout.stripe.test/session",
    );
    assert.equal(
      harness.getCheckoutCalls(),
      1,
    );
    assert.equal(
      harness.getApplyCalls(),
      0,
    );
    assert.ok(
      result.paymentExpiresAt,
    );
    assert.notEqual(
      result.paymentExpiresAt
        ?.toISOString(),
      quoteExpiry
        .toISOString(),
    );
  },
);

test(
  "E2E price drift after confirmation supersedes the quote and forces review before canonical modification",
  async () => {
    const harness =
      createHarness(
        "PAYMENT_REQUIRED",
      );

    await harness
      .prepareThroughRuntime();

    harness.setPreview(
      makePreview({
        financialAction:
          "ADDITIONAL_PAYMENT_REQUIRED",
        amountDifferenceCents:
          18_120,
        proposedTotalAmountCents:
          53_455,
        fingerprint:
          "c".repeat(64),
      }),
    );

    const result =
      await harness
        .confirmThroughBroker();

    assert.equal(
      result.outcome,
      "REVIEW_REQUIRED",
    );
    assert.equal(
      result.actionExecuted,
      false,
    );
    assert.equal(
      result.reasonCode,
      "QUOTE_CHANGED",
    );
    assert.equal(
      harness.getSupersedeCalls(),
      1,
    );
    assert.equal(
      harness
        .getConfirmModificationCalls(),
      0,
    );
    assert.equal(
      harness
        .getProposal()
        .status,
      PinAIActionProposalStatus
        .SUPERSEDED,
    );
    assert.ok(
      harness
        .getProposal()
        .confirmedAt,
    );
  },
);

test(
  "E2E host-review path returns WAITING_FOR_HOST and never claims the reservation changed",
  async () => {
    const harness =
      createHarness(
        "HOST_APPROVAL",
      );

    await harness
      .prepareThroughRuntime();

    const result =
      await harness
        .confirmThroughBroker();

    assert.equal(
      result.outcome,
      "WAITING_FOR_HOST",
    );
    assert.equal(
      result.actionExecuted,
      false,
    );
    assert.equal(
      result.reasonCode,
      "HOST_APPROVAL_REQUIRED",
    );
    assert.equal(
      harness.getApplyCalls(),
      0,
    );
    assert.equal(
      harness.getCheckoutCalls(),
      0,
    );
    assert.equal(
      harness
        .getConfirmModificationCalls(),
      1,
    );
  },
);
