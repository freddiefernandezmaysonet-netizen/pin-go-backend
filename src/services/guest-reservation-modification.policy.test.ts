import assert from "node:assert/strict";
import test from "node:test";
import {
  ReservationModificationFinancialAction,
  ReservationModificationStatus,
} from "@prisma/client";
import {
  assertGuestCountChangeAllowed,
  buildGuestReservationModificationPreviewFingerprint,
  buildGuestReservationModificationRequestFingerprint,
  evaluateGuestReservationModificationReduction,
  getGuestReservationModificationInitialStatus,
  getGuestReservationModificationOptions,
  getGuestReservationModificationPreview,
} from "./guest-reservation-modification.service";

const currentCheckIn = new Date("2026-10-10T20:00:00.000Z");
const currentCheckOut = new Date("2026-10-15T15:00:00.000Z");

test("private-property in-stay extension reaches canonical pricing while normal changes stay blocked", async () => {
  const now = new Date("2026-10-12T13:00:00Z");
  const property = { id: "private-property", organizationId: "host", name: "Synthetic",
    status: "ACTIVE", isPublicBookable: false, pinAIEnabled: true, pinAIFeeExempt: false,
    pinAITermsVersion: "pin-ai-connect-usd-1-reservation-v1",
    pinAITermsAcceptedAt: new Date("2026-10-01T12:00:00Z"), pinAITermsAcceptedBy: "host",
    organization: { pinAIEnabled: true, pinAIRevision: 1, stripeConnectAccountId: "acct_synthetic" },
    timezone: "America/Puerto_Rico", checkInTime: "15:00", checkOutTime: "11:00",
    maxGuests: 3, minimumNights: 1, maximumNights: 30, amenities: [] };
  const reservation = { id: "paid-stay", propertyId: property.id, property,
    reservationNumber: "SYNTHETIC", source: "DIRECT_BOOKING", externalProvider: "PIN_GO_DIRECT",
    status: "ACTIVE", paymentState: "PAID", checkIn: new Date("2026-10-11T19:00:00Z"),
    checkOut: new Date("2026-10-13T15:00:00Z"), updatedAt: now, currency: "usd",
    adults: 2, children: 0, selectedAmenityIds: [], totalAmount: 250,
    verificationGuestCount: null, verificationAcceptedRulesAt: null,
    guestAgreementAcceptance: null, guestAgreementSignedAt: null,
    pricingBreakdown: { currency: "usd", nights: 2, nightlyRate: 100, nightlySubtotal: 200, cleaningFee: 50,
      amenitiesTotal: 0, taxesTotal: 0, totalAmount: 250, totalAmountCents: 25000,
      nightlyRates: [{ date: "2026-10-11", rate: 100 }, { date: "2026-10-12", rate: 100 }],
      amenities: [], taxes: [] } };
  let availabilityChecks = 0;
  const dependencies: NonNullable<Parameters<typeof getGuestReservationModificationOptions>[1]> = {
    now: () => now,
    env: { PIN_AI_ALL_ORGANIZATIONS_ENABLED: "true", PIN_AI_PROPERTY_ACTIVATION_ENABLED: "true",
      PIN_AI_CONNECT_DEBIT_ENABLED: "true", PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "true",
      PIN_AI_ACTION_BROKER_ENABLED: "true", PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED: "true" },
    client: { reservation: { findFirst: async () => reservation },
      property: { findFirst: async () => property.status === "ACTIVE" ? property : null } } as never,
    checkAvailability: (async () => { availabilityChecks++; return { available: true }; }) as never,
    calculatePricing: (async () => ({ currency: "usd",
      nightlyRates: [{ date: "2026-10-13", rate: 100 }], amenities: [], taxes: [] })) as never,
  };
  const input = { guestToken: "synthetic-token", allowInStayExtension: true };
  const options = await getGuestReservationModificationOptions(input, dependencies);
  assert.equal(options.managementPhase, "IN_STAY");
  assert.equal(options.constraints.guestCountEditable, false);
  const preview = await getGuestReservationModificationPreview({
    guestToken: input.guestToken, operation: "EXTEND_CHECKOUT_ONLY",
    checkIn: reservation.checkIn, checkOut: new Date("2026-10-14T15:00:00Z"),
    adults: 2, children: 0, selectedAmenityIds: [],
  }, dependencies);
  assert.equal(preview.pricing.amountDifferenceCents, 10000);
  assert.equal(availabilityChecks, 1);
  assert.equal(property.isPublicBookable, false);
  assert.equal(reservation.checkOut.toISOString(), "2026-10-13T15:00:00.000Z");
  await assert.rejects(getGuestReservationModificationOptions({ ...input, allowInStayExtension: false }, dependencies),
    { code: "RESERVATION_NOT_ELIGIBLE_FOR_MODIFICATION" });
  property.status = "INACTIVE";
  await assert.rejects(getGuestReservationModificationOptions(input, dependencies),
    { code: "RESERVATION_NOT_ELIGIBLE_FOR_MODIFICATION" });
  property.status = "ACTIVE";
  property.pinAIEnabled = false;
  await assert.rejects(getGuestReservationModificationOptions(input, dependencies),
    { code: "RESERVATION_NOT_ELIGIBLE_FOR_MODIFICATION" });
  property.pinAIEnabled = true;
  reservation.checkIn = new Date("2026-10-12T19:00:00Z");
  await assert.rejects(getGuestReservationModificationOptions(input, dependencies),
    { code: "PROPERTY_NOT_AVAILABLE_FOR_MODIFICATION" });
});

test("does not apply reduction policy when the price does not decrease", () => {
  const result = evaluateGuestReservationModificationReduction({
    amountDifferenceCents: 0,
    currentCheckIn,
    currentCheckOut,
    proposedCheckIn: currentCheckIn,
    proposedCheckOut: currentCheckOut,
    nonRefundableScenarios: ["DELAYED_ARRIVAL", "REDUCED_NIGHTS"],
  });

  assert.deepEqual(result, {
    outcome: "NOT_APPLICABLE",
    nonRefundableReasons: [],
    requiresHostApproval: false,
    refundableReductionAmountCents: 0,
  });
});

test("does not refund a delayed arrival when accepted terms make it non-refundable", () => {
  const result = evaluateGuestReservationModificationReduction({
    amountDifferenceCents: -10_000,
    currentCheckIn,
    currentCheckOut,
    proposedCheckIn: new Date("2026-10-11T20:00:00.000Z"),
    proposedCheckOut: currentCheckOut,
    nonRefundableScenarios: ["DELAYED_ARRIVAL"],
  });

  assert.deepEqual(result, {
    outcome: "NO_REFUND_DUE",
    nonRefundableReasons: ["DELAYED_ARRIVAL"],
    requiresHostApproval: false,
    refundableReductionAmountCents: 0,
  });
});

test("does not refund reduced nights when accepted terms make them non-refundable", () => {
  const result = evaluateGuestReservationModificationReduction({
    amountDifferenceCents: -10_000,
    currentCheckIn,
    currentCheckOut,
    proposedCheckIn: currentCheckIn,
    proposedCheckOut: new Date("2026-10-14T15:00:00.000Z"),
    nonRefundableScenarios: ["REDUCED_NIGHTS"],
  });

  assert.deepEqual(result, {
    outcome: "NO_REFUND_DUE",
    nonRefundableReasons: ["REDUCED_NIGHTS"],
    requiresHostApproval: false,
    refundableReductionAmountCents: 0,
  });
});

test("requires host approval when no accepted non-refundable scenario covers the reduction", () => {
  const result = evaluateGuestReservationModificationReduction({
    amountDifferenceCents: -10_000,
    currentCheckIn,
    currentCheckOut,
    proposedCheckIn: currentCheckIn,
    proposedCheckOut: new Date("2026-10-14T15:00:00.000Z"),
    nonRefundableScenarios: [],
  });

  assert.deepEqual(result, {
    outcome: "HOST_APPROVAL_REQUIRED",
    nonRefundableReasons: [],
    requiresHostApproval: true,
    refundableReductionAmountCents: null,
  });
});

test("builds the same fingerprint for the same canonical modification request", () => {
  const first = buildGuestReservationModificationRequestFingerprint({
    checkIn: currentCheckIn,
    checkOut: currentCheckOut,
    adults: 2,
    children: 1,
    selectedAmenityIds: ["amenity-b", "amenity-a", "amenity-b"],
    acceptNoRefundReduction: false,
  });
  const replay = buildGuestReservationModificationRequestFingerprint({
    checkIn: new Date(currentCheckIn),
    checkOut: new Date(currentCheckOut),
    adults: 2,
    children: 1,
    selectedAmenityIds: ["amenity-a", "amenity-b"],
    acceptNoRefundReduction: false,
  });

  assert.equal(first, replay);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("changes the fingerprint when a material request value changes", () => {
  const common = {
    checkIn: currentCheckIn,
    checkOut: currentCheckOut,
    adults: 2,
    children: 1,
    selectedAmenityIds: ["amenity-a"],
    acceptNoRefundReduction: false,
  };
  const base = buildGuestReservationModificationRequestFingerprint(common);
  const changedGuests = buildGuestReservationModificationRequestFingerprint({
    ...common,
    adults: 3,
  });
  const changedConfirmation =
    buildGuestReservationModificationRequestFingerprint({
      ...common,
      acceptNoRefundReduction: true,
    });

  assert.notEqual(base, changedGuests);
  assert.notEqual(base, changedConfirmation);
});

test("rejects invalid dates before building an idempotency fingerprint", () => {
  assert.throws(
    () =>
      buildGuestReservationModificationRequestFingerprint({
        checkIn: new Date("invalid"),
        checkOut: currentCheckOut,
        adults: 2,
        children: 0,
        selectedAmenityIds: [],
        acceptNoRefundReduction: false,
      }),
    /Missing or invalid check-in\/check-out dates/
  );
});

test("builds a stable quoted-preview fingerprint and binds material price terms", () => {
  const preview = {
    reservation: {
      version: new Date("2026-10-01T12:00:00.000Z"),
      currency: "USD",
      current: {
        checkIn: currentCheckIn,
        checkOut: currentCheckOut,
        adults: 2,
        children: 0,
        selectedAmenityIds: ["amenity-b", "amenity-a"],
        totalAmountCents: 35_335,
      },
      proposed: {
        checkIn: currentCheckIn,
        checkOut: new Date("2026-10-16T15:00:00.000Z"),
        adults: 2,
        children: 0,
        selectedAmenityIds: ["amenity-a", "amenity-b"],
      },
    },
    changes: {
      datesChanged: true,
      guestsChanged: false,
      amenitiesChanged: false,
      hasChanges: true,
      requiresSecurePreCheckinRefresh: false,
    },
    pricing: {
      proposed: {
        totalAmountCents: 52_185,
        totalAmount: 521.85,
        taxes: [
          { name: "Tax B", amount: 20 },
          { name: "Tax A", amount: 10 },
        ],
      },
      amountDifferenceCents: 16_850,
      financialAction: "ADDITIONAL_PAYMENT_REQUIRED",
      reductionPolicy: {
        outcome: "NOT_APPLICABLE",
        nonRefundableReasons: [],
        requiresHostApproval: false,
        refundableReductionAmountCents: 0,
      },
    },
  };

  const first = buildGuestReservationModificationPreviewFingerprint(preview);
  const reordered = buildGuestReservationModificationPreviewFingerprint({
    ...preview,
    reservation: {
      ...preview.reservation,
      current: {
        ...preview.reservation.current,
        selectedAmenityIds: ["amenity-a", "amenity-b"],
      },
    },
    pricing: {
      ...preview.pricing,
      proposed: {
        taxes: [
          { amount: 20, name: "Tax B" },
          { amount: 10, name: "Tax A" },
        ],
        totalAmount: 521.85,
        totalAmountCents: 52_185,
      },
    },
  });
  const changedPrice = buildGuestReservationModificationPreviewFingerprint({
    ...preview,
    pricing: {
      ...preview.pricing,
      proposed: {
        ...(preview.pricing.proposed as Record<string, unknown>),
        totalAmountCents: 53_455,
        totalAmount: 534.55,
      },
      amountDifferenceCents: 18_120,
    },
  });

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, reordered);
  assert.notEqual(first, changedPrice);
});

test("maps every financial action to its durable initial status", () => {
  assert.equal(
    getGuestReservationModificationInitialStatus(
      ReservationModificationFinancialAction.ADDITIONAL_PAYMENT_REQUIRED
    ),
    ReservationModificationStatus.AWAITING_PAYMENT
  );
  assert.equal(
    getGuestReservationModificationInitialStatus(
      ReservationModificationFinancialAction.NO_PAYMENT_REQUIRED
    ),
    ReservationModificationStatus.APPLYING
  );
  assert.equal(
    getGuestReservationModificationInitialStatus(
      ReservationModificationFinancialAction.NO_REFUND_DUE_CONFIRMATION_REQUIRED
    ),
    ReservationModificationStatus.APPLYING
  );
  assert.equal(
    getGuestReservationModificationInitialStatus(
      ReservationModificationFinancialAction.REDUCTION_REVIEW_REQUIRED
    ),
    ReservationModificationStatus.HOST_APPROVAL_REQUIRED
  );
});

test("keeps the guest count editable before secure pre-check-in evidence exists", () => {
  const result = assertGuestCountChangeAllowed({
    currentAdults: 2,
    currentChildren: 0,
    proposedAdults: 3,
    proposedChildren: 0,
    securePreCheckin: {
      verificationGuestCount: null,
      verificationAcceptedRulesAt: null,
      guestAgreementAcceptance: null,
      guestAgreementSignedAt: null,
    },
  });

  assert.deepEqual(result, { guestsChanged: true });
});

test("preserves signed secure pre-check-in evidence by locking guest count changes", () => {
  assert.throws(
    () =>
      assertGuestCountChangeAllowed({
        currentAdults: 2,
        currentChildren: 0,
        proposedAdults: 2,
        proposedChildren: 1,
        securePreCheckin: {
          verificationGuestCount: 2,
          verificationAcceptedRulesAt: new Date(
            "2026-10-01T12:00:00.000Z"
          ),
          guestAgreementAcceptance: {
            accepted: true,
            guestCount: 2,
          },
          guestAgreementSignedAt: new Date(
            "2026-10-01T12:00:00.000Z"
          ),
        },
      }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "GUEST_COUNT_LOCKED_AFTER_SECURE_PRECHECKIN"
      );
      assert.equal((error as { statusCode?: number }).statusCode, 409);
      return true;
    }
  );
});

test("allows unchanged guest counts after secure pre-check-in", () => {
  const result = assertGuestCountChangeAllowed({
    currentAdults: 2,
    currentChildren: 1,
    proposedAdults: 2,
    proposedChildren: 1,
    securePreCheckin: {
      verificationGuestCount: 3,
      verificationAcceptedRulesAt: new Date("2026-10-01T12:00:00.000Z"),
      guestAgreementAcceptance: { accepted: true, guestCount: 3 },
      guestAgreementSignedAt: new Date("2026-10-01T12:00:00.000Z"),
    },
  });

  assert.deepEqual(result, { guestsChanged: false });
});
