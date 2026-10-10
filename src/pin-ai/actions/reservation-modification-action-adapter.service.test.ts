import assert from "node:assert/strict";
import test from "node:test";

import {
  PinAIActionProposalStatus,
  PinAIActionProposalType,
  ReservationModificationStatus,
} from "@prisma/client";

import {
  PIN_AI_RESERVATION_MODIFICATION_QUOTE_TTL_MS,
  PinAIReservationModificationActionAdapter,
  type PinAIReservationModificationActionAdapterDependencies,
} from "./reservation-modification-action-adapter.service.js";

const GUEST_TOKEN =
  "12345678-1234-1234-1234-123456789abc";
const PROPOSAL_ID =
  "proposal-12345678";
const PROPOSAL_FINGERPRINT =
  "b".repeat(64);
const PREVIEW_FINGERPRINT =
  "a".repeat(64);
const BASE_NOW =
  new Date("2026-09-26T13:00:00.000Z");

function preview(
  overrides: Partial<{
    managementPhase: "PRE_STAY" | "IN_STAY";
    previewFingerprint: string;
    financialAction: string;
    amountDifferenceCents: number;
    proposedTotalAmountCents: number;
  }> = {},
) {
  return {
    managementPhase:
      overrides.managementPhase ?? "PRE_STAY",
    modificationAllowed:
      true as const,
    reservation: {
      reservationNumber:
        "PG-2026-000999",
      version:
        new Date(
          "2026-09-26T12:55:00.000Z",
        ),
      propertyName:
        "Pin&Go Demo Property",
      status: "ACTIVE",
      paymentState: "PAID",
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
        totalGuests: 2,
        selectedAmenityIds: [],
        totalAmount: 353.35,
        totalAmountCents: 35_335,
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
        totalGuests: 2,
        selectedAmenityIds: [],
      },
    },
    property: {
      timezone:
        "America/Puerto_Rico",
      checkInTime: "16:00",
      checkOutTime: "11:00",
      maxGuests: 4,
      minimumNights: 2,
      maximumNights: null,
      optionalAmenities: [],
    },
    changes: {
      datesChanged: true,
      guestsChanged: false,
      amenitiesChanged: false,
      hasChanges: true,
      requiresSecurePreCheckinRefresh:
        false,
    },
    pricing: {
      currentTotalAmount: 353.35,
      currentTotalAmountCents:
        35_335,
      proposed: {
        currency: "usd",
        nights: 4,
        nightlyRate: 100,
        nightlyRates: [],
        nightlySubtotal: 400,
        cleaningFee: 60,
        amenities: [],
        chargedAmenities: [],
        amenitiesTotal: 0,
        taxableSubtotal: 460,
        taxes: [],
        taxesTotal: 61.85,
        totalAmount:
          (overrides
            .proposedTotalAmountCents ??
            52_185) / 100,
        totalAmountCents:
          overrides
            .proposedTotalAmountCents ??
          52_185,
      },
      amountDifference:
        (overrides
          .amountDifferenceCents ??
          16_850) / 100,
      amountDifferenceCents:
        overrides
          .amountDifferenceCents ??
        16_850,
      additionalPaymentAmountCents:
        Math.max(
          0,
          overrides
            .amountDifferenceCents ??
            16_850,
        ),
      potentialReductionAmountCents:
        0,
      financialAction:
        overrides
          .financialAction ??
        "ADDITIONAL_PAYMENT_REQUIRED",
      reductionPolicy: {
        outcome:
          "NOT_APPLICABLE",
        nonRefundableReasons: [],
        requiresHostApproval: false,
        refundableReductionAmountCents:
          0,
      },
    },
    previewFingerprint:
      overrides
        .previewFingerprint ??
      PREVIEW_FINGERPRINT,
  };
}

function createHarness(previewElapsedMs = 0) {
  let now =
    new Date(BASE_NOW);
  let currentPreview =
    preview();
  let proposalRecord:
    any = null;
  let createProposalInput:
    any = null;
  let confirmInput:
    any = null;
  const previewInputs: unknown[] = [];
  let supersedeCalls = 0;
  let confirmStatus:
    ReservationModificationStatus =
      ReservationModificationStatus
        .APPLYING;
  let checkoutExpiresAt =
    new Date(
      BASE_NOW.getTime() +
        80 * 60 * 1000,
    );

  const prisma = {
    pinAIActionProposal: {
      async findFirst() {
        return proposalRecord;
      },
    },
  };

  const dependencies = {
    prisma,
    async getPreview(input: unknown) {
      previewInputs.push(input);
      now = new Date(now.getTime() + previewElapsedMs);
      return currentPreview;
    },
    async createProposal(
      input: any,
    ) {
      createProposalInput = input;
      const expiresAt =
        new Date(
          input.expiresAt,
        );

      return {
        ok: true,
        idempotentReplay:
          false,
        actionExecuted:
          false,
        confirmationToken:
          "confirmation-token-123456789012345678901234",
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
            PROPOSAL_FINGERPRINT,
          baseReservationUpdatedAt:
            currentPreview
              .reservation.version,
          language:
            input.language,
          consentText:
            input.consentText,
          termsSnapshot:
            input.termsSnapshot,
          expiresAt,
          confirmedAt: null,
          cancelledAt: null,
          supersededAt: null,
          createdAt: now,
        },
      };
    },
    async supersedeProposal() {
      supersedeCalls += 1;
      if (proposalRecord) {
        proposalRecord = {
          ...proposalRecord,
          status:
            PinAIActionProposalStatus
              .SUPERSEDED,
          supersededAt:
            new Date(now),
        };
      }

      return {
        ok: true,
        idempotentReplay:
          false,
        actionExecuted:
          false,
        proposal:
          proposalRecord,
      };
    },
    async confirmModification(
      input: any,
    ) {
      confirmInput = input;
      return {
        ok: true,
        idempotentReplay:
          false,
        modification: {
          id:
            "modification-12345678",
          status:
            confirmStatus,
          financialAction:
            currentPreview.pricing
              .financialAction,
          currency: "usd",
          currentTotalAmount:
            353.35,
          proposedTotalAmount:
            currentPreview.pricing
              .proposed.totalAmount,
          amountDifference:
            currentPreview.pricing
              .amountDifference,
          additionalChargeAmount:
            Math.max(
              0,
              currentPreview
                .pricing
                .amountDifference,
            ),
          additionalPlatformFeeAmount:
            0,
          additionalHostPayoutAmount:
            0,
          checkoutExpiresAt:
            null,
          appliedAt: null,
          createdAt:
            new Date(now),
          nextAction: "NONE",
        },
      };
    },
    async createCheckout() {
      return {
        checkoutUrl:
          "https://checkout.stripe.test/session",
        checkoutExpiresAt:
          new Date(
            checkoutExpiresAt,
          ),
      };
    },
    async applyModification() {
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
      new Date(now),
  } as unknown as
    PinAIReservationModificationActionAdapterDependencies;

  const adapter =
    new PinAIReservationModificationActionAdapter(
      dependencies,
    );

  async function prepare(
    language: "en" | "es" =
      "es",
    operation?: "EXTEND_CHECKOUT_ONLY",
  ) {
    const result =
      await adapter.prepare({
        ...(operation ? { operation } : {}),
        guestToken:
          GUEST_TOKEN,
        checkIn:
          currentPreview
            .reservation.proposed
            .checkIn,
        checkOut:
          currentPreview
            .reservation.proposed
            .checkOut,
        adults: 2,
        children: 0,
        selectedAmenityIds: [],
        language,
      });

    proposalRecord = {
      id:
        result.proposal.id,
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
          .CONFIRMED,
      proposalFingerprint:
        PROPOSAL_FINGERPRINT,
      termsSnapshot:
        createProposalInput
          .termsSnapshot,
      expiresAt:
        result.proposal
          .expiresAt,
      confirmedAt:
        new Date(
          BASE_NOW.getTime() +
            60_000,
        ),
      supersededAt: null,
      reservation: {
        id:
          "reservation-a",
        propertyId:
          "property-a",
        guestTokenExpiresAt:
          new Date(
            BASE_NOW.getTime() +
              3 * 60 * 60 * 1000,
          ),
        property: {
          organizationId:
            "organization-a",
        },
      },
    };

    return result;
  }

  return {
    adapter,
    prepare,
    setNow(value: Date) {
      now = new Date(value);
    },
    setPreview(value: ReturnType<
      typeof preview
    >) {
      currentPreview = value;
    },
    setConfirmStatus(
      value:
        ReservationModificationStatus,
    ) {
      confirmStatus = value;
    },
    setCheckoutExpiresAt(
      value: Date,
    ) {
      checkoutExpiresAt =
        new Date(value);
    },
    getPreviewInputs: () => previewInputs,
    getCreateProposalInput:
      () => createProposalInput,
    getConfirmInput:
      () => confirmInput,
    getSupersedeCalls:
      () => supersedeCalls,
  };
}

test(
  "prepares a 60-minute quote with exact property-local expiry and no availability hold",
  async () => {
    const harness =
      createHarness();
    const result =
      await harness.prepare("es");
    const input =
      harness
        .getCreateProposalInput();

    const expectedExpiry =
      new Date(
        BASE_NOW.getTime() +
          PIN_AI_RESERVATION_MODIFICATION_QUOTE_TTL_MS,
      );

    assert.equal(
      result.actionExecuted,
      false,
    );
    assert.equal(
      result.quote
        .quoteExpiresAt
        .toISOString(),
      expectedExpiry.toISOString(),
    );
    assert.equal(
      result.quote
        .priceGuaranteedUntil
        .toISOString(),
      expectedExpiry.toISOString(),
    );
    assert.equal(
      result.quote
        .quoteExpiresAtLocal,
      "2026-09-26T10:00:00-04:00",
    );
    assert.equal(
      result.quote
        .propertyTimezone,
      "America/Puerto_Rico",
    );
    assert.equal(
      result.quote
        .availabilityHeld,
      false,
    );
    assert.equal(
      input.termsSnapshot
        .availabilityHeld,
      false,
    );
    assert.equal(
      input.termsSnapshot
        .previewFingerprint,
      PREVIEW_FINGERPRINT,
    );
    assert.match(
      input.consentText,
      /10:00:00-04:00/,
    );
    assert.match(
      input.consentText,
      /no retiene las fechas/i,
    );
    assert.deepEqual(result.quote.reservationChange, {
      currentCheckIn: input.termsSnapshot.current.checkIn,
      currentCheckOut: input.termsSnapshot.current.checkOut,
      proposedCheckIn: input.termsSnapshot.proposed.checkIn,
      proposedCheckOut: input.termsSnapshot.proposed.checkOut,
      consentText: input.consentText,
      language: "es",
    });
    assert.match(input.consentText, /Estadía actual:/);
    assert.match(input.consentText, /Nueva estadía:/);
  },
);

test(
  "executes an APPLYING canonical modification only after quoted preview revalidation",
  async () => {
    const harness =
      createHarness();
    const prepared =
      await harness.prepare();
    harness.setConfirmStatus(
      ReservationModificationStatus
        .APPLYING,
    );

    const result =
      await harness.adapter
        .execute({
          guestToken:
            GUEST_TOKEN,
          proposalId:
            prepared.proposal.id,
        });

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

    const input =
      harness.getConfirmInput();
    assert.equal(
      input.clientRequestId,
      `pin_ai_${PROPOSAL_ID}`,
    );
    assert.equal(
      input.expectedPreviewFingerprint,
      PREVIEW_FINGERPRINT,
    );
    assert.equal(
      input.confirmationSource,
      "PIN_AI_GUEST_SERVICES",
    );
    assert.equal(
      input.actionProposalId,
      PROPOSAL_ID,
    );
    assert.equal(
      input.actionProposalFingerprint,
      PROPOSAL_FINGERPRINT,
    );
  },
);

test(
  "returns a separate payment window when the confirmed modification requires payment",
  async () => {
    const harness =
      createHarness();
    const prepared =
      await harness.prepare();
    harness.setConfirmStatus(
      ReservationModificationStatus
        .AWAITING_PAYMENT,
    );

    harness.setNow(
      new Date(
        BASE_NOW.getTime() +
          20 * 60 * 1000,
      ),
    );
    const paymentExpiry =
      new Date(
        BASE_NOW.getTime() +
          80 * 60 * 1000,
      );
    harness.setCheckoutExpiresAt(
      paymentExpiry,
    );

    const result =
      await harness.adapter
        .execute({
          guestToken:
            GUEST_TOKEN,
          proposalId:
            prepared.proposal.id,
        });

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
      result.paymentExpiresAt
        ?.toISOString(),
      paymentExpiry.toISOString(),
    );
    assert.notEqual(
      result.paymentExpiresAt
        ?.toISOString(),
      result.quoteExpiresAt
        .toISOString(),
    );
  },
);

test(
  "returns WAITING_FOR_HOST without claiming the reservation changed",
  async () => {
    const harness =
      createHarness();
    const prepared =
      await harness.prepare();
    harness.setConfirmStatus(
      ReservationModificationStatus
        .HOST_APPROVAL_REQUIRED,
    );

    const result =
      await harness.adapter
        .execute({
          guestToken:
            GUEST_TOKEN,
          proposalId:
            prepared.proposal.id,
        });

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
  },
);

test(
  "supersedes a confirmed proposal when the canonical preview changes",
  async () => {
    const harness =
      createHarness();
    const prepared =
      await harness.prepare();

    harness.setPreview(
      preview({
        previewFingerprint:
          "c".repeat(64),
        proposedTotalAmountCents:
          53_455,
        amountDifferenceCents:
          18_120,
      }),
    );

    const result =
      await harness.adapter
        .execute({
          guestToken:
            GUEST_TOKEN,
          proposalId:
            prepared.proposal.id,
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
      "QUOTE_CHANGED",
    );
    assert.equal(
      harness
        .getSupersedeCalls(),
      1,
    );
    assert.equal(
      harness.getConfirmInput(),
      null,
    );
  },
);

test(
  "supersedes an expired confirmed quote before attempting modification",
  async () => {
    const harness =
      createHarness();
    const prepared =
      await harness.prepare();

    harness.setNow(
      new Date(
        BASE_NOW.getTime() +
          61 * 60 * 1000,
      ),
    );

    const result =
      await harness.adapter
        .execute({
          guestToken:
            GUEST_TOKEN,
          proposalId:
            prepared.proposal.id,
        });

    assert.equal(
      result.outcome,
      "REVIEW_REQUIRED",
    );
    assert.equal(
      result.reasonCode,
      "QUOTE_EXPIRED",
    );
    assert.equal(
      result.actionExecuted,
      false,
    );
    assert.equal(
      harness
        .getSupersedeCalls(),
      1,
    );
    assert.equal(
      harness.getConfirmInput(),
      null,
    );
  },
);

test("extension operation survives terms storage, requote and canonical confirmation", async () => {
  const h = createHarness();
  const value = preview({ managementPhase: "IN_STAY" });
  value.reservation.current.checkIn = new Date("2026-09-25T18:17:03.123Z");
  value.reservation.current.checkOut = new Date("2026-09-27T15:00:00Z");
  value.reservation.proposed.checkIn = new Date(value.reservation.current.checkIn);
  value.reservation.proposed.checkOut = new Date("2026-09-28T15:00:00Z");
  h.setPreview(value);
  await h.prepare("es", "EXTEND_CHECKOUT_ONLY");
  assert.equal(h.getCreateProposalInput().termsSnapshot.operation, "EXTEND_CHECKOUT_ONLY");
  await h.adapter.execute({ guestToken: GUEST_TOKEN, proposalId: PROPOSAL_ID });
  const previews = h.getPreviewInputs() as Array<{ operation?: string; checkIn: Date }>;
  assert.equal(previews.length, 2);
  for (const input of previews) {
    assert.equal(input.operation, "EXTEND_CHECKOUT_ONLY");
    assert.equal(input.checkIn.toISOString(), "2026-09-25T18:17:03.123Z");
  }
  assert.equal(h.getConfirmInput().operation, "EXTEND_CHECKOUT_ONLY");
});

test("adapter refuses extension terms that would change the original check-in", async () => {
  const h = createHarness();
  const value = preview({ managementPhase: "IN_STAY" });
  value.reservation.proposed.checkIn = new Date("2026-10-02T20:00:00Z");
  h.setPreview(value);
  await assert.rejects(h.prepare("es", "EXTEND_CHECKOUT_ONLY"), /INVALID_QUOTE_TERMS/);
  assert.equal(h.getCreateProposalInput(), null);
});

for (const remainingMs of [120 * 60_000, 40 * 60_000, 30 * 60_000 + 1, 30 * 60_000, 29 * 60_000]) {
  test(`paid extension quote respects original-checkout payment window: ${remainingMs}ms remaining`, async () => {
    const h = createHarness();
    const value = preview({ managementPhase: "IN_STAY", amountDifferenceCents: 100 });
    value.reservation.current.checkIn = new Date(BASE_NOW.getTime() - 86_400_000);
    value.reservation.current.checkOut = new Date(BASE_NOW.getTime() + remainingMs);
    value.reservation.proposed.checkIn = new Date(value.reservation.current.checkIn);
    value.reservation.proposed.checkOut = new Date(value.reservation.current.checkOut.getTime() + 86_400_000);
    h.setPreview(value);
    if (remainingMs <= 30 * 60_000) {
      await assert.rejects(h.prepare("es", "EXTEND_CHECKOUT_ONLY"), /EXTENSION_CONFIRMATION_WINDOW_CLOSED/);
      assert.equal(h.getCreateProposalInput(), null);
    } else {
      const result = await h.prepare("es", "EXTEND_CHECKOUT_ONLY");
      const expected = new Date(BASE_NOW.getTime() + Math.min(60 * 60_000, remainingMs - 30 * 60_000));
      assert.equal(result.quote.quoteExpiresAt.getTime(), expected.getTime());
      assert.equal(result.quote.priceGuaranteedUntil.getTime(), expected.getTime());
      assert.equal(h.getCreateProposalInput().termsSnapshot.quoteExpiresAt, expected.toISOString());
      h.setNow(expected);
      const expired = await h.adapter.execute({guestToken: GUEST_TOKEN, proposalId: PROPOSAL_ID});
      assert.equal(expired.outcome, "REVIEW_REQUIRED");
      assert.equal(expired.reasonCode, "QUOTE_EXPIRED");
      assert.equal(expired.actionExecuted, false);
      assert.equal(h.getConfirmInput(), null);
    }
  });
}

test("extension without additional payment expires at original checkout without the payment buffer", async () => {
  const h = createHarness();
  const value = preview({ managementPhase: "IN_STAY", amountDifferenceCents: 0, financialAction: "NO_FINANCIAL_CHANGE" });
  value.reservation.current.checkIn = new Date(BASE_NOW.getTime() - 86_400_000);
  value.reservation.current.checkOut = new Date(BASE_NOW.getTime() + 20 * 60_000);
  value.reservation.proposed.checkIn = new Date(value.reservation.current.checkIn);
  value.reservation.proposed.checkOut = new Date(value.reservation.current.checkOut.getTime() + 86_400_000);
  h.setPreview(value);
  const result = await h.prepare("es", "EXTEND_CHECKOUT_ONLY");
  assert.equal(result.quote.quoteExpiresAt.getTime(), value.reservation.current.checkOut.getTime());
});


test("preview latency cannot create a proposal after the confirmation window closes", async () => {
  const h = createHarness(10 * 60_000);
  const value = preview({ managementPhase: "IN_STAY", amountDifferenceCents: 100 });
  value.reservation.current.checkIn = new Date(BASE_NOW.getTime() - 86_400_000);
  value.reservation.current.checkOut = new Date(BASE_NOW.getTime() + 40 * 60_000);
  value.reservation.proposed.checkIn = new Date(value.reservation.current.checkIn);
  value.reservation.proposed.checkOut = new Date(value.reservation.current.checkOut.getTime() + 86_400_000);
  h.setPreview(value);
  await assert.rejects(h.prepare("es", "EXTEND_CHECKOUT_ONLY"), /EXTENSION_CONFIRMATION_WINDOW_CLOSED/);
  assert.equal(h.getCreateProposalInput(), null);
});
