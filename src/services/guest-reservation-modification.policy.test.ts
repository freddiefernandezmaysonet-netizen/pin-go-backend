import assert from "node:assert/strict";
import test from "node:test";
import {
  ReservationModificationFinancialAction,
  ReservationModificationStatus,
} from "@prisma/client";
import {
  assertGuestCountChangeAllowed,
  buildGuestReservationModificationRequestFingerprint,
  evaluateGuestReservationModificationReduction,
  getGuestReservationModificationInitialStatus,
} from "./guest-reservation-modification.service";

const currentCheckIn = new Date("2026-10-10T20:00:00.000Z");
const currentCheckOut = new Date("2026-10-15T15:00:00.000Z");

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
