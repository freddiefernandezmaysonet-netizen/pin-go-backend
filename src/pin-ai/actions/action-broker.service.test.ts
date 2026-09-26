import assert from "node:assert/strict";
import test from "node:test";

import {
  PinAIActionProposalStatus,
  PinAIActionProposalType,
  ReservationModificationStatus,
} from "@prisma/client";

import {
  PinAIActionBroker,
  PinAIActionBrokerError,
} from "./action-broker.service.js";
import {
  PinAIActionProposalError,
} from "./action-proposal.service.js";

const NOW =
  new Date("2026-09-26T14:00:00.000Z");
const GUEST_TOKEN =
  "12345678-1234-1234-1234-123456789abc";
const PROPOSAL_ID =
  "proposal-12345678";
const CONFIRMATION_TOKEN =
  "confirmation-token-private-123456789012345";

function preparedResult() {
  const expiresAt =
    new Date(
      NOW.getTime() +
        60 * 60 * 1000,
    );

  return {
    ok: true as const,
    actionExecuted:
      false as const,
    proposal: {
      id: PROPOSAL_ID,
      version:
        "pin_ai_action_proposal_v1",
      actionType:
        PinAIActionProposalType
          .RESERVATION_MODIFICATION,
      status:
        PinAIActionProposalStatus
          .PENDING_CONFIRMATION,
      proposalFingerprint:
        "a".repeat(64),
      baseReservationUpdatedAt:
        new Date(NOW),
      language: "es",
      consentText:
        "Confirmo estos términos.",
      termsSnapshot: {},
      expiresAt,
      confirmedAt: null,
      cancelledAt: null,
      supersededAt: null,
      createdAt:
        new Date(NOW),
    },
    confirmationToken:
      CONFIRMATION_TOKEN,
    quote: {
      quotedAt:
        new Date(NOW),
      quoteExpiresAt:
        expiresAt,
      quoteExpiresAtLocal:
        "2026-09-26T11:00:00-04:00",
      priceGuaranteedUntil:
        expiresAt,
      propertyTimezone:
        "America/Puerto_Rico",
      availabilityCheckedAt:
        new Date(NOW),
      availabilityHeld:
        false as const,
      currentTotalAmount:
        353.35,
      proposedTotalAmount:
        521.85,
      amountDifference:
        168.5,
      amountDifferenceCents:
        16_850,
      currency: "usd",
      financialAction:
        "ADDITIONAL_PAYMENT_REQUIRED",
    },
  };
}

function createHarness(
  options: Partial<{
    expired:
      boolean;
    outcome:
      "EXECUTED"
      | "WAITING_FOR_PAYMENT"
      | "WAITING_FOR_HOST"
      | "REVIEW_REQUIRED";
  }> = {},
) {
  let prepareCalls = 0;
  let executeCalls = 0;
  let confirmCalls = 0;
  let confirmedToken:
    unknown = null;

  const reservationModification = {
    async prepare() {
      prepareCalls += 1;
      return preparedResult();
    },
    async execute() {
      executeCalls += 1;
      return {
        ok: true as const,
        outcome:
          options.outcome ??
          "WAITING_FOR_PAYMENT",
        actionExecuted:
          options.outcome ===
          "EXECUTED",
        proposalId:
          PROPOSAL_ID,
        quoteExpiresAt:
          preparedResult()
            .quote.quoteExpiresAt,
        quoteExpiresAtLocal:
          preparedResult()
            .quote
            .quoteExpiresAtLocal,
        propertyTimezone:
          "America/Puerto_Rico",
        availabilityHeld:
          false as const,
        modificationId:
          "modification-12345678",
        modificationStatus:
          options.outcome ===
          "EXECUTED"
            ? ReservationModificationStatus
                .APPLIED
            : ReservationModificationStatus
                .AWAITING_PAYMENT,
        checkoutUrl:
          options.outcome ===
          "WAITING_FOR_PAYMENT"
            ? "https://checkout.stripe.test/session"
            : null,
        paymentExpiresAt:
          options.outcome ===
          "WAITING_FOR_PAYMENT"
            ? new Date(
                NOW.getTime() +
                  80 * 60 * 1000,
              )
            : null,
        amountDifference:
          168.5,
        amountDifferenceCents:
          16_850,
        currency: "usd",
        reasonCode: null,
      };
    },
  };

  const broker =
    new PinAIActionBroker({
      prisma: {
        pinAIActionProposal:
          {} as never,
        reservation:
          {} as never,
      } as never,
      reservationModification:
        reservationModification as never,
      async confirmProposal(
        input,
      ) {
        confirmCalls += 1;
        confirmedToken =
          input.confirmationToken;

        if (options.expired) {
          throw new PinAIActionProposalError(
            "PROPOSAL_EXPIRED",
            410,
          );
        }

        if (
          input.confirmationToken !==
          CONFIRMATION_TOKEN
        ) {
          throw new PinAIActionProposalError(
            "PROPOSAL_TOKEN_MISMATCH",
            403,
          );
        }

        return {
          proposalConfirmed:
            true as const,
          actionExecuted:
            false as const,
          proposal: {
            id: PROPOSAL_ID,
            actionType:
              PinAIActionProposalType
                .RESERVATION_MODIFICATION,
            expiresAt:
              preparedResult()
                .proposal.expiresAt,
          },
        };
      },
      now: () =>
        new Date(NOW),
    });

  return {
    broker,
    getPrepareCalls:
      () => prepareCalls,
    getExecuteCalls:
      () => executeCalls,
    getConfirmCalls:
      () => confirmCalls,
    getConfirmedToken:
      () => confirmedToken,
  };
}

test(
  "prepare separates model-safe proposal data from the private confirmation credential",
  async () => {
    const harness =
      createHarness();

    const result =
      await harness.broker
        .prepareReservationModification({
          guestToken:
            GUEST_TOKEN,
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
          language: "es",
        });

    assert.equal(
      result.publicResult
        .proposalId,
      PROPOSAL_ID,
    );
    assert.equal(
      result.publicResult
        .requiresGuestConfirmation,
      true,
    );
    assert.equal(
      result.publicResult
        .actionExecuted,
      false,
    );
    assert.equal(
      result.publicResult
        .quote.availabilityHeld,
      false,
    );
    assert.equal(
      result.privateConfirmation
        .confirmationToken,
      CONFIRMATION_TOKEN,
    );

    const modelPayload =
      JSON.stringify(
        result.publicResult,
      );
    assert.equal(
      modelPayload.includes(
        CONFIRMATION_TOKEN,
      ),
      false,
    );
    assert.equal(
      modelPayload.includes(
        "confirmationToken",
      ),
      false,
    );
    assert.equal(
      harness.getPrepareCalls(),
      1,
    );
  },
);

test(
  "confirmation delegates to the canonical adapter and returns the stable broker outcome",
  async () => {
    const harness =
      createHarness({
        outcome:
          "WAITING_FOR_PAYMENT",
      });

    const result =
      await harness.broker
        .confirmAndExecute({
          guestToken:
            GUEST_TOKEN,
          proposalId:
            PROPOSAL_ID,
          confirmationToken:
            CONFIRMATION_TOKEN,
        });

    assert.equal(
      harness.getConfirmCalls(),
      1,
    );
    assert.equal(
      harness
        .getConfirmedToken(),
      CONFIRMATION_TOKEN,
    );
    assert.equal(
      harness.getExecuteCalls(),
      1,
    );
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
      result.availabilityHeld,
      false,
    );
  },
);

test(
  "an expired proposal returns REVIEW_REQUIRED and never calls the action adapter execute path",
  async () => {
    const harness =
      createHarness({
        expired: true,
      });

    const result =
      await harness.broker
        .confirmAndExecute({
          guestToken:
            GUEST_TOKEN,
          proposalId:
            PROPOSAL_ID,
          confirmationToken:
            CONFIRMATION_TOKEN,
        });

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
      "QUOTE_EXPIRED",
    );
    assert.equal(
      harness.getExecuteCalls(),
      0,
    );
  },
);

test(
  "a wrong confirmation token is never downgraded into a harmless review result",
  async () => {
    const harness =
      createHarness();

    await assert.rejects(
      () =>
        harness.broker
          .confirmAndExecute({
            guestToken:
              GUEST_TOKEN,
            proposalId:
              PROPOSAL_ID,
            confirmationToken:
              "wrong-confirmation-token-123456789012345",
          }),
      (error: unknown) =>
        error instanceof
          PinAIActionProposalError &&
        error.code ===
          "PROPOSAL_TOKEN_MISMATCH" &&
        error.statusCode === 403,
    );

    assert.equal(
      harness.getExecuteCalls(),
      0,
    );
  },
);

test(
  "broker rejects a confirmed action of the wrong type before execution",
  async () => {
    const harness =
      createHarness();

    const broker =
      new PinAIActionBroker({
        prisma: {
          pinAIActionProposal:
            {} as never,
          reservation:
            {} as never,
        } as never,
        reservationModification:
          {
            async prepare() {
              return preparedResult();
            },
            async execute() {
              throw new Error(
                "SHOULD_NOT_EXECUTE",
              );
            },
          } as never,
        async confirmProposal() {
          return {
            proposalConfirmed:
              true as const,
            actionExecuted:
              false as const,
            proposal: {
              id:
                PROPOSAL_ID,
              actionType:
                "SOME_FUTURE_ACTION" as
                  PinAIActionProposalType,
              expiresAt:
                preparedResult()
                  .proposal
                  .expiresAt,
            },
          };
        },
        now: () =>
          new Date(NOW),
      });

    await assert.rejects(
      () =>
        broker.confirmAndExecute({
          guestToken:
            GUEST_TOKEN,
          proposalId:
            PROPOSAL_ID,
          confirmationToken:
            CONFIRMATION_TOKEN,
        }),
      (error: unknown) =>
        error instanceof
          PinAIActionBrokerError &&
        error.code ===
          "INVALID_ACTION_TYPE",
    );
  },
);
