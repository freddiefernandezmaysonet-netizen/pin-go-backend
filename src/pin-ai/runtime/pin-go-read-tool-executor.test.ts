import assert from "node:assert/strict";
import test from "node:test";

import type { PinAIRuntimeRequest } from "./contracts.js";
import { createConversationMemory } from "./conversation-memory.js";
import { PinGoRuntimeReadToolExecutor } from "./pin-go-read-tool-executor.js";

const request: PinAIRuntimeRequest = {
  context: {
    organizationId: "org-a",
    propertyId: "property-a",
    reservationId: "reservation-a",
    guestId: "guest-a",
    currentLocalDateTime: "2026-09-20T12:00:00-04:00",
    preferredLanguage: "en",
  },
  conversation: [{ role: "guest", content: "What is my access status?" }],
};

const cancellationPolicySnapshot = {
  policyId: "policy-a",
  name: "Moderate",
  type: "MODERATE",
  source: "PROPERTY_POLICY",
  guestSelfCancellationEnabled: true,
  autoRefundEligibleCancellations: true,
  requireHostApprovalOutsidePolicy: true,
  freeCancellationHoursBeforeCheckIn: 336,
  refundBasis: "NIGHTLY_SUBTOTAL",
  refundPercentBeforeDeadline: 100,
  refundPercentAfterDeadline: 0,
  refundRules: [
    {
      minHoursBeforeCheckIn: 336,
      refundPercent: 100,
      label: "Full refund",
      description: "At least 14 days before check-in.",
    },
  ],
  nonRefundableScenarios: ["EARLY_DEPARTURE", "DELAYED_ARRIVAL"],
  guestFacingSummary: "Full refund at least 14 days before check-in.",
  cleaningFeeRefundable: false,
  amenitiesRefundable: false,
  taxesRefundable: true,
  nonRefundableDiscountPercent: null,
  description: "Moderate cancellation terms.",
  snapshotAt: "2026-08-01T12:00:00.000Z",
  guestAcceptedCancellationTerms: true,
  guestAcceptedCancellationTermsText: "private acceptance evidence",
};

function createPrismaFixture(options: Readonly<{
  reservationConflict?: Readonly<{
    checkIn: Date;
    checkOut: Date;
  }>;
  currentTotalAmount?: number | null;
  minimumNights?: number | null;
  maximumNights?: number | null;
  modificationHold?: boolean;
  blockedDate?: boolean;
  cancellationPolicySnapshot?: unknown;
  paymentContext?: Readonly<{
    paymentState?: string;
    totalAmount?: number | null;
    amountCollected?: number | null;
    amountRefunded?: number | null;
  }>;
}> = {}) {
  const paymentContext = options.paymentContext ?? {};

  return {
    property: {
      async findFirst() {
        return {
          id: "property-a",
          organizationId: "org-a",
          name: "Casa Test",
          publicTitle: "Casa Test",
          publicDescription: "Test property",
          publicDescriptionEs: "Propiedad de prueba",
          maxGuests: 4,
          timezone: "America/Puerto_Rico",
          checkInTime: "16:00",
          checkOutTime: "11:00",
          guestAccessMode: "PASSCODE_ONLY",
          amenities: [],
          locks: [],
          propertyDevices: [],
          guestAgreements: [],
          cancellationPolicies: [],
        };
      },
    },
    reservation: {
      async findFirst(args: any) {
        if (args?.where?.id?.not) {
          return options.reservationConflict ?? null;
        }
        if (args?.select?.id === true && Object.keys(args.select).length === 1) {
          return { id: "reservation-a" };
        }
        return {
          id: "reservation-a",
          reservationNumber: "#PG-2026-000001",
          propertyId: "property-a",
          preferredLanguage: "en",
          checkIn: new Date("2026-09-20T20:00:00.000Z"),
          checkOut: new Date("2026-09-22T15:00:00.000Z"),
          adults: 2,
          children: 0,
          status: "ACTIVE",
          totalAmount:
            "totalAmount" in paymentContext
              ? paymentContext.totalAmount
              : "currentTotalAmount" in options
                ? options.currentTotalAmount
                : 400,
          currency: "usd",
          selectedAmenityIds: ["amenity-a"],
          source: "DIRECT_BOOKING",
          paymentState: paymentContext.paymentState ?? "PAID",
          amountCollected:
            "amountCollected" in paymentContext
              ? paymentContext.amountCollected
              : 400,
          amountRefunded:
            "amountRefunded" in paymentContext
              ? paymentContext.amountRefunded
              : 0,
          stripeCheckoutSessionId: "cs_private_001",
          stripePaymentIntentId: "pi_private_001",
          stripeChargeId: "ch_private_001",
          verificationStatus: "VERIFIED",
          identityVerificationRequiredSnapshot: true,
          stripeIdentityVerificationStatus: "VERIFIED",
          guestAgreementSignedAt: new Date("2026-09-19T20:00:00.000Z"),
          guestAccessReleaseStatus: "RELEASED",
          guestAccessEligibleAt: new Date("2026-09-20T18:00:00.000Z"),
          guestAccessReleasedAt: new Date("2026-09-20T18:01:00.000Z"),
          guestAccessModeSnapshot: "PASSCODE_ONLY",
          cancellationPolicySnapshot:
            "cancellationPolicySnapshot" in options
              ? options.cancellationPolicySnapshot
              : { version: "v1" },
          pricingBreakdown: {
            nightlySubtotal: 300,
            cleaningFee: 50,
            amenitiesTotal: 25,
            taxesTotal: 25,
          },
          cancelledAt: null,
          property: {
            organizationId: "org-a",
            timezone: "America/Puerto_Rico",
            checkInTime: "16:00",
            checkOutTime: "11:00",
            maxGuests: 4,
            minimumNights:
              "minimumNights" in options ? options.minimumNights : 1,
            maximumNights:
              "maximumNights" in options ? options.maximumNights : 14,
          },
        };
      },
    },
    accessGrant: {
      async findMany() {
        return [
          {
            method: "PASSCODE",
            status: "ACTIVE",
            startsAt: new Date("2026-09-20T18:00:00.000Z"),
            endsAt: new Date("2026-09-22T15:00:00.000Z"),
            type: "GUEST",
            lastError: null,
            recoveryOperation: null,
            recoveryAttemptCount: 0,
            recoveryExhaustedAt: null,
            lastAppliedAt: new Date("2026-09-20T18:01:00.000Z"),
            revokedReason: null,
            lock: {
              displayName: "Front Door",
              locationLabel: "Main entrance",
              isActive: true,
            },
          },
        ];
      },
    },
    cleaningConfirmation: {
      async findFirst() {
        return {
          status: "CONFIRMED",
          createdAt: new Date("2026-09-20T12:00:00.000Z"),
          updatedAt: new Date("2026-09-20T13:00:00.000Z"),
        };
      },
      async findMany() {
        return [
          {
            status: "CONFIRMED",
            createdAt: new Date("2026-09-20T12:00:00.000Z"),
            updatedAt: new Date("2026-09-20T13:00:00.000Z"),
          },
        ];
      },
    },
    propertyBlockedDate: {
      async findFirst() {
        return options.blockedDate ? { id: "blocked-a" } : null;
      },
    },
    reservationModification: {
      async findFirst() {
        return options.modificationHold ? { id: "modification-a" } : null;
      },
    },
  };
}

test("real read adapter returns scoped reservation context without guest PII or Stripe IDs", async () => {
  const executor = new PinGoRuntimeReadToolExecutor(createPrismaFixture());
  const result = await executor.execute(
    "get_reservation_context",
    {},
    request,
    createConversationMemory(request),
  );

  const serialized = JSON.stringify(result);
  assert.match(serialized, /#PG-2026-000001/);
  assert.doesNotMatch(serialized, /guestEmail|guestPhone|guestToken|stripePaymentIntentId/);
});

test("real read adapter exposes access state without credentials or TTLock identifiers", async () => {
  const executor = new PinGoRuntimeReadToolExecutor(createPrismaFixture());
  const result = await executor.execute(
    "get_access_status",
    {},
    request,
    createConversationMemory(request),
  );

  const serialized = JSON.stringify(result);
  assert.match(serialized, /ACTIVE/);
  assert.match(serialized, /Front Door/);
  assert.doesNotMatch(
    serialized,
    /accessCodeMasked|unlockKey|ttlockKeyboardPwdId|ttlockKeyId|ttlockPayload|ttlockLockId/,
  );
});

test("real read adapter returns cleaning confirmation state without token or staff identity", async () => {
  const executor = new PinGoRuntimeReadToolExecutor(createPrismaFixture());
  const result = await executor.execute(
    "get_cleaning_status",
    {},
    request,
    createConversationMemory(request),
  );

  const serialized = JSON.stringify(result);
  assert.match(serialized, /CONFIRMED/);
  assert.doesNotMatch(serialized, /token|staffMemberId/);
});

test("real read adapter calculates an extension estimate without authorization or execution", async () => {
  let pricingInput: Record<string, unknown> | null = null;
  const executor = new PinGoRuntimeReadToolExecutor(
    createPrismaFixture(),
    async (input) => {
      pricingInput = input;
      return {
        currency: "usd",
        totalAmount: 525,
        totalAmountCents: 52500,
        nightlyRates: [
          { date: "2026-09-20", rate: 150 },
          { date: "2026-09-21", rate: 150 },
          { date: "2026-09-22", rate: 100 },
        ],
      } as any;
    },
  );

  const lateCheckout = await executor.execute(
    "check_late_checkout",
    { requestedLocalTime: "13:00" },
    request,
    createConversationMemory(request),
  );

  assert.equal(lateCheckout.authorizationGranted, false);

  const result = await executor.execute(
    "calculate_extension_price",
    { additionalNights: 1 },
    request,
    createConversationMemory(request),
  );

  assert.deepEqual(pricingInput, {
    propertyId: "property-a",
    checkIn: new Date("2026-09-20T20:00:00.000Z"),
    checkOut: new Date("2026-09-23T15:00:00.000Z"),
    selectedAmenityIds: ["amenity-a"],
    excludeReservationId: "reservation-a",
  });
  assert.equal(result.decision, "PRICE_CALCULATED_FOR_REVIEW");
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.priceCalculated, true);
  assert.equal(result.additionalAmount, 125);
  assert.equal(result.additionalAmountCents, 12500);
  assert.equal(result.chargeExecuted, false);
  assert.equal(result.reservationChanged, false);
  assert.deepEqual(result.extensionNightlyRates, [
    { date: "2026-09-22", rate: 100 },
  ]);
});

test("extension price is not calculated when extension availability fails", async () => {
  const prisma = createPrismaFixture({
    reservationConflict: {
      checkIn: new Date("2026-09-22T20:00:00.000Z"),
      checkOut: new Date("2026-09-24T15:00:00.000Z"),
    },
  });

  let pricingExecutions = 0;
  const executor = new PinGoRuntimeReadToolExecutor(prisma, async () => {
    pricingExecutions += 1;
    throw new Error("PRICING_SHOULD_NOT_EXECUTE");
  });

  const result = await executor.execute(
    "calculate_extension_price",
    { additionalNights: 1 },
    request,
    createConversationMemory(request),
  );

  assert.equal(result.decision, "NOT_AVAILABLE");
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.priceCalculated, false);
  assert.equal(pricingExecutions, 0);
});

test("extension price is not calculated beyond the maximum stay", async () => {
  let pricingExecutions = 0;
  const executor = new PinGoRuntimeReadToolExecutor(
    createPrismaFixture({ maximumNights: 2 }),
    async () => {
      pricingExecutions += 1;
      throw new Error("PRICING_SHOULD_NOT_EXECUTE");
    },
  );

  const result = await executor.execute(
    "calculate_extension_price",
    { additionalNights: 1 },
    request,
    createConversationMemory(request),
  );

  assert.equal(result.decision, "MAXIMUM_STAY_EXCEEDED");
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.priceCalculated, false);
  assert.equal(result.maximumNights, 2);
  assert.equal(result.proposedNights, 3);
  assert.equal(pricingExecutions, 0);
});

test("extension price fails closed when the current reservation total is unavailable", async () => {
  let pricingExecutions = 0;
  const executor = new PinGoRuntimeReadToolExecutor(
    createPrismaFixture({ currentTotalAmount: null }),
    async () => {
      pricingExecutions += 1;
      throw new Error("PRICING_SHOULD_NOT_EXECUTE");
    },
  );

  const result = await executor.execute(
    "calculate_extension_price",
    { additionalNights: 1 },
    request,
    createConversationMemory(request),
  );

  assert.equal(result.decision, "CURRENT_RESERVATION_TOTAL_UNAVAILABLE");
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.priceCalculated, false);
  assert.equal(pricingExecutions, 0);
});

test("non-positive extension differences require review and are never presented as a charge", async () => {
  const executor = new PinGoRuntimeReadToolExecutor(
    createPrismaFixture(),
    async () =>
      ({
        currency: "usd",
        totalAmount: 350,
        totalAmountCents: 35000,
        nightlyRates: [{ date: "2026-09-22", rate: 100 }],
      }) as any,
  );

  const result = await executor.execute(
    "calculate_extension_price",
    { additionalNights: 1 },
    request,
    createConversationMemory(request),
  );

  assert.equal(result.decision, "PRICE_REQUIRES_HUMAN_REVIEW");
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.amountDifference, -50);
  assert.equal(result.additionalAmount, null);
  assert.equal(result.additionalAmountCents, null);
  assert.equal(result.pricingReviewRequired, true);
  assert.equal(result.chargeExecuted, false);
  assert.equal(result.reservationChanged, false);
});

test("date change previews exact proposed dates without authorization or execution", async () => {
  let pricingInput: Record<string, unknown> | null = null;
  const executor = new PinGoRuntimeReadToolExecutor(
    createPrismaFixture(),
    async (input) => {
      pricingInput = input;
      return {
        currency: "usd",
        totalAmount: 450,
        totalAmountCents: 45000,
        nightlyRates: [],
      } as any;
    },
  );

  const result = await executor.execute(
    "check_date_change",
    {
      proposedCheckInDate: "2026-09-23",
      proposedCheckOutDate: "2026-09-25",
    },
    request,
    createConversationMemory(request),
  );

  assert.deepEqual(pricingInput, {
    propertyId: "property-a",
    checkIn: new Date("2026-09-23T20:00:00.000Z"),
    checkOut: new Date("2026-09-25T15:00:00.000Z"),
    selectedAmenityIds: ["amenity-a"],
    excludeReservationId: "reservation-a",
  });
  assert.equal(result.decision, "DATE_CHANGE_AVAILABLE_FOR_REVIEW");
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.priceCalculated, true);
  assert.equal(result.nights, 2);
  assert.equal(result.amountDifference, 50);
  assert.equal(result.financialReview, "ADDITIONAL_PAYMENT_REVIEW_REQUIRED");
  assert.equal(result.additionalAmount, 50);
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.chargeExecuted, false);
  assert.equal(result.refundExecuted, false);
  assert.equal(result.reservationChanged, false);
});

test("date change fails closed on invalid or missing proposed dates", async () => {
  let pricingExecutions = 0;
  const executor = new PinGoRuntimeReadToolExecutor(
    createPrismaFixture(),
    async () => {
      pricingExecutions += 1;
      throw new Error("PRICING_SHOULD_NOT_EXECUTE");
    },
  );

  const missing = await executor.execute(
    "check_date_change",
    { proposedCheckInDate: "2026-09-23" },
    request,
    createConversationMemory(request),
  );
  const invalid = await executor.execute(
    "check_date_change",
    {
      proposedCheckInDate: "2026-02-30",
      proposedCheckOutDate: "2026-03-02",
    },
    request,
    createConversationMemory(request),
  );

  assert.equal(missing.decision, "PROPOSED_DATES_REQUIRED");
  assert.equal(invalid.decision, "INVALID_PROPOSED_DATES");
  assert.equal(missing.authorizationGranted, false);
  assert.equal(invalid.reservationChanged, false);
  assert.equal(pricingExecutions, 0);
});

test("date change does not price dates that conflict with an active reservation", async () => {
  let pricingExecutions = 0;
  const executor = new PinGoRuntimeReadToolExecutor(
    createPrismaFixture({
      reservationConflict: {
        checkIn: new Date("2026-09-23T20:00:00.000Z"),
        checkOut: new Date("2026-09-25T15:00:00.000Z"),
      },
    }),
    async () => {
      pricingExecutions += 1;
      throw new Error("PRICING_SHOULD_NOT_EXECUTE");
    },
  );

  const result = await executor.execute(
    "check_date_change",
    {
      proposedCheckInDate: "2026-09-23",
      proposedCheckOutDate: "2026-09-25",
    },
    request,
    createConversationMemory(request),
  );

  assert.equal(result.decision, "NOT_AVAILABLE");
  assert.equal(result.reason, "ACTIVE_RESERVATION_CONFLICT");
  assert.equal(result.priceCalculated, false);
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.reservationChanged, false);
  assert.equal(pricingExecutions, 0);
});

test("date change respects active modification holds and blocked dates", async () => {
  const inputs = [
    {
      fixture: createPrismaFixture({ modificationHold: true }),
      reason: "ACTIVE_RESERVATION_MODIFICATION_HOLD",
    },
    {
      fixture: createPrismaFixture({ blockedDate: true }),
      reason: "PROPERTY_BLOCKED_DATE",
    },
  ];

  for (const input of inputs) {
    let pricingExecutions = 0;
    const executor = new PinGoRuntimeReadToolExecutor(
      input.fixture,
      async () => {
        pricingExecutions += 1;
        throw new Error("PRICING_SHOULD_NOT_EXECUTE");
      },
    );
    const result = await executor.execute(
      "check_date_change",
      {
        proposedCheckInDate: "2026-09-23",
        proposedCheckOutDate: "2026-09-25",
      },
      request,
      createConversationMemory(request),
    );

    assert.equal(result.decision, "NOT_AVAILABLE");
    assert.equal(result.reason, input.reason);
    assert.equal(result.priceCalculated, false);
    assert.equal(result.refundExecuted, false);
    assert.equal(pricingExecutions, 0);
  }
});

test("date change enforces minimum and maximum stays before pricing", async () => {
  const cases = [
    {
      fixture: createPrismaFixture({ minimumNights: 3 }),
      proposedCheckOutDate: "2026-09-25",
      decision: "MINIMUM_STAY_NOT_MET",
    },
    {
      fixture: createPrismaFixture({ maximumNights: 2 }),
      proposedCheckOutDate: "2026-09-26",
      decision: "MAXIMUM_STAY_EXCEEDED",
    },
  ];

  for (const input of cases) {
    let pricingExecutions = 0;
    const executor = new PinGoRuntimeReadToolExecutor(
      input.fixture,
      async () => {
        pricingExecutions += 1;
        throw new Error("PRICING_SHOULD_NOT_EXECUTE");
      },
    );
    const result = await executor.execute(
      "check_date_change",
      {
        proposedCheckInDate: "2026-09-23",
        proposedCheckOutDate: input.proposedCheckOutDate,
      },
      request,
      createConversationMemory(request),
    );

    assert.equal(result.decision, input.decision);
    assert.equal(result.authorizationGranted, false);
    assert.equal(result.priceCalculated, false);
    assert.equal(pricingExecutions, 0);
  }
});

test("date change presents a lower estimate as potential reduction, never a refund", async () => {
  const executor = new PinGoRuntimeReadToolExecutor(
    createPrismaFixture(),
    async () =>
      ({
        currency: "usd",
        totalAmount: 350,
        totalAmountCents: 35000,
        nightlyRates: [],
      }) as any,
  );

  const result = await executor.execute(
    "check_date_change",
    {
      proposedCheckInDate: "2026-09-23",
      proposedCheckOutDate: "2026-09-25",
    },
    request,
    createConversationMemory(request),
  );

  assert.equal(result.decision, "DATE_CHANGE_AVAILABLE_FOR_REVIEW");
  assert.equal(result.amountDifference, -50);
  assert.equal(result.financialReview, "POTENTIAL_REDUCTION_REVIEW_REQUIRED");
  assert.equal(result.additionalAmount, null);
  assert.equal(result.potentialReductionAmount, 50);
  assert.equal(result.refundExecuted, false);
  assert.equal(result.chargeExecuted, false);
  assert.equal(result.reservationChanged, false);
});

test("cancellation policy evaluates the reservation snapshot without executing cancellation or refund", async () => {
  let evaluationInput: Record<string, unknown> | null = null;
  const executor = new PinGoRuntimeReadToolExecutor(
    createPrismaFixture({ cancellationPolicySnapshot }),
    undefined,
    async (input) => {
      evaluationInput = input;
      return {
        requestedAt: "2026-09-20T16:00:00.000Z",
        checkIn: "2026-09-20T20:00:00.000Z",
        freeCancellationDeadline: "2026-09-06T20:00:00.000Z",
        hoursBeforeCheckIn: 4,
        beforeDeadline: false,
        refundPercent: 0,
        refundAmount: 0,
        refundAmountCents: 0,
        usesTieredRules: true,
        matchedRefundRule: null,
        eligibleForGuestSelfCancellation: false,
        eligibleForAutoRefund: false,
        requiresHostApproval: true,
        reason: "CANCELLATION_REQUIRES_HOST_APPROVAL",
        breakdown: {
          refundableBase: 300,
          refundableBaseCents: 30000,
        },
      };
    },
  );

  const result = await executor.execute(
    "get_cancellation_policy",
    {},
    request,
    createConversationMemory(request),
  );

  assert.deepEqual(evaluationInput, {
    snapshot: {
      policyId: "policy-a",
      name: "Moderate",
      type: "MODERATE",
      source: "PROPERTY_POLICY",
      guestSelfCancellationEnabled: true,
      autoRefundEligibleCancellations: true,
      requireHostApprovalOutsidePolicy: true,
      freeCancellationHoursBeforeCheckIn: 336,
      refundBasis: "NIGHTLY_SUBTOTAL",
      refundPercentBeforeDeadline: 100,
      refundPercentAfterDeadline: 0,
      refundRules: cancellationPolicySnapshot.refundRules,
      nonRefundableScenarios: cancellationPolicySnapshot.nonRefundableScenarios,
      guestFacingSummary: cancellationPolicySnapshot.guestFacingSummary,
      cleaningFeeRefundable: false,
      amenitiesRefundable: false,
      taxesRefundable: true,
      nonRefundableDiscountPercent: null,
      description: cancellationPolicySnapshot.description,
      snapshotAt: cancellationPolicySnapshot.snapshotAt,
    },
    checkIn: new Date("2026-09-20T20:00:00.000Z"),
    totalAmount: 400,
    pricingBreakdown: {
      nightlySubtotal: 300,
      cleaningFee: 50,
      amenitiesTotal: 25,
      taxesTotal: 25,
    },
    requestedAt: new Date("2026-09-20T16:00:00.000Z"),
    actor: "GUEST",
  });
  assert.equal(result.decision, "CANCELLATION_POLICY_EVALUATED");
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.cancellationExecuted, false);
  assert.equal(result.refundExecuted, false);
  assert.equal(result.chargeExecuted, false);
  assert.equal(
    (result.evaluation as Record<string, unknown>).estimatedRefundAmount,
    0,
  );
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private acceptance evidence/);
  assert.doesNotMatch(serialized, /guestAcceptedCancellationTerms/);
});

test("cancellation policy uses the canonical engine for its read-only estimate", async () => {
  const executor = new PinGoRuntimeReadToolExecutor(
    createPrismaFixture({ cancellationPolicySnapshot }),
  );

  const result = await executor.execute(
    "get_cancellation_policy",
    {},
    request,
    createConversationMemory(request),
  );
  const evaluation = result.evaluation as Record<string, unknown>;

  assert.equal(result.decision, "CANCELLATION_POLICY_EVALUATED");
  assert.equal(evaluation.refundPercent, 0);
  assert.equal(evaluation.estimatedRefundAmount, 0);
  assert.equal(evaluation.refundableBase, 300);
  assert.equal(evaluation.requiresHostApproval, true);
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.cancellationExecuted, false);
  assert.equal(result.refundExecuted, false);
});

test("cancellation policy fails closed when the reservation snapshot is missing or invalid", async () => {
  let evaluationExecutions = 0;
  const executor = new PinGoRuntimeReadToolExecutor(
    createPrismaFixture({ cancellationPolicySnapshot: null }),
    undefined,
    async () => {
      evaluationExecutions += 1;
      throw new Error("EVALUATION_SHOULD_NOT_EXECUTE");
    },
  );

  const result = await executor.execute(
    "get_cancellation_policy",
    {},
    request,
    createConversationMemory(request),
  );

  assert.equal(result.decision, "CANCELLATION_POLICY_SNAPSHOT_UNAVAILABLE");
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.cancellationExecuted, false);
  assert.equal(result.refundExecuted, false);
  assert.equal(evaluationExecutions, 0);
});

test("payment context returns guest-safe persisted amounts without financial authority", async () => {
  const executor = new PinGoRuntimeReadToolExecutor(
    createPrismaFixture({
      paymentContext: {
        paymentState: "PARTIALLY_REFUNDED",
        totalAmount: 400,
        amountCollected: 400,
        amountRefunded: 125,
      },
    }),
  );

  const result = await executor.execute(
    "get_payment_context",
    {},
    request,
    createConversationMemory(request),
  );
  const payment = result.payment as Record<string, unknown>;
  const authority = result.financialAuthority as Record<string, unknown>;

  assert.equal(result.decision, "PAYMENT_CONTEXT_READ");
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.requiresHumanReview, false);
  assert.equal(payment.state, "PARTIALLY_REFUNDED");
  assert.equal(payment.totalAmount, 400);
  assert.equal(payment.amountCollected, 400);
  assert.equal(payment.amountRefunded, 125);
  assert.equal(payment.amountRetained, 275);
  assert.equal(payment.paymentRecorded, true);
  assert.equal(payment.refundRecorded, true);
  assert.equal(authority.canCharge, false);
  assert.equal(authority.canRefund, false);
  assert.equal(authority.canTransfer, false);
  assert.equal(result.paymentAuthorized, false);
  assert.equal(result.chargeExecuted, false);
  assert.equal(result.refundExecuted, false);
  assert.equal(result.transferExecuted, false);

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /cs_private_001/);
  assert.doesNotMatch(serialized, /pi_private_001/);
  assert.doesNotMatch(serialized, /ch_private_001/);
  assert.doesNotMatch(
    serialized,
    /stripeCheckoutSessionId|stripePaymentIntentId|stripeChargeId|hostPayout/i,
  );
});

test("payment context fails closed on invalid persisted amounts", async () => {
  const executor = new PinGoRuntimeReadToolExecutor(
    createPrismaFixture({
      paymentContext: {
        paymentState: "PAID",
        amountCollected: null,
        amountRefunded: 0,
      },
    }),
  );

  const result = await executor.execute(
    "get_payment_context",
    {},
    request,
    createConversationMemory(request),
  );

  assert.equal(result.decision, "PAYMENT_CONTEXT_INVALID");
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.paymentAuthorized, false);
  assert.equal(result.chargeExecuted, false);
  assert.equal(result.refundExecuted, false);
  assert.equal(result.transferExecuted, false);
  assert.equal(result.payment, undefined);
});
