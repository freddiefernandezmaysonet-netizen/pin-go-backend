import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PaymentState,
  ReservationModificationFinancialAction,
  ReservationModificationStatus,
  ReservationStatus,
} from "@prisma/client";

import { buildGuestReservationModificationApplyPlan } from "./guest-reservation-modification-apply.service";

const now = new Date("2026-10-01T12:00:00.000Z");
const currentCheckIn = new Date("2026-10-10T20:00:00.000Z");
const currentCheckOut = new Date("2026-10-15T15:00:00.000Z");

function createInput(): Parameters<typeof buildGuestReservationModificationApplyPlan>[0] {
  return {
    now,
    modification: {
      status: ReservationModificationStatus.APPLYING,
      financialAction:
        ReservationModificationFinancialAction.NO_PAYMENT_REQUIRED,
      currentCheckIn,
      currentCheckOut,
      proposedCheckIn: currentCheckIn,
      proposedCheckOut: currentCheckOut,
      currentAdults: 2,
      currentChildren: 0,
      proposedAdults: 2,
      proposedChildren: 0,
      currentSelectedAmenityIds: ["amenity-a"],
      proposedSelectedAmenityIds: ["amenity-a"],
      currentTotalAmount: 500,
      proposedTotalAmount: 500,
      amountDifference: 0,
      additionalChargeAmount: 0,
      additionalPlatformFeeAmount: 0,
      additionalHostPayoutAmount: 0,
      currency: "usd",
      guestConfirmation: {
        confirmed: true,
        acceptedNoRefundReduction: false,
      },
      stripeConnectedAccountId: null,
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: null,
      stripeChargeId: null,
      stripeTransferId: null,
      stripeApplicationFeeId: null,
      stripePaymentStatus: null,
    },
    reservation: {
      status: ReservationStatus.ACTIVE,
      paymentState: PaymentState.PAID,
      checkIn: currentCheckIn,
      checkOut: currentCheckOut,
      adults: 2,
      children: 0,
      selectedAmenityIds: ["amenity-a"],
      totalAmount: 500,
      amountCollected: 500,
      platformFeeAmount: 50,
      hostPayoutAmount: 450,
      currency: "usd",
      stripeConnectedAccountId: "acct_host_1",
      verificationGuestCount: null,
      verificationAcceptedRulesAt: null,
      guestAgreementAcceptance: null,
      guestAgreementSignedAt: null,
    },
  };
}

test("builds a canonical no-payment apply plan without changing financial totals", () => {
  const input = createInput();
  input.modification.proposedCheckOut = new Date(
    "2026-10-16T15:00:00.000Z"
  );

  const plan = buildGuestReservationModificationApplyPlan(input);

  assert.equal(plan.datesChanged, true);
  assert.equal(plan.guestsChanged, false);
  assert.equal(plan.amenitiesChanged, false);
  assert.equal(plan.nextAmountCollected, 500);
  assert.equal(plan.nextPlatformFeeAmount, 50);
  assert.equal(plan.nextHostPayoutAmount, 450);
  assert.equal(
    plan.guestTokenExpiresAt.toISOString(),
    "2026-10-18T15:00:00.000Z"
  );
});

test("rejects apply when the canonical reservation snapshot changed", () => {
  const input = createInput();
  input.reservation.adults = 3;

  assert.throws(
    () => buildGuestReservationModificationApplyPlan(input),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "RESERVATION_CHANGED_BEFORE_MODIFICATION_APPLY"
      );
      return true;
    }
  );
});

test("rejects guest count changes after secure pre-check-in evidence exists", () => {
  const input = createInput();
  input.modification.proposedAdults = 3;
  input.reservation.verificationGuestCount = 2;
  input.reservation.verificationAcceptedRulesAt = new Date(
    "2026-10-01T10:00:00.000Z"
  );
  input.reservation.guestAgreementAcceptance = {
    accepted: true,
    guestCount: 2,
  };
  input.reservation.guestAgreementSignedAt = new Date(
    "2026-10-01T10:00:00.000Z"
  );

  assert.throws(
    () => buildGuestReservationModificationApplyPlan(input),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "GUEST_COUNT_LOCKED_AFTER_SECURE_PRECHECKIN"
      );
      return true;
    }
  );
});

test("accumulates a fully evidenced additional Stripe payment", () => {
  const input = createInput();
  input.modification.financialAction =
    ReservationModificationFinancialAction.ADDITIONAL_PAYMENT_REQUIRED;
  input.modification.proposedTotalAmount = 600;
  input.modification.amountDifference = 100;
  input.modification.additionalChargeAmount = 100;
  input.modification.additionalPlatformFeeAmount = 10;
  input.modification.additionalHostPayoutAmount = 90;
  input.modification.stripeConnectedAccountId = "acct_host_1";
  input.modification.stripeCheckoutSessionId = "cs_modification_1";
  input.modification.stripePaymentIntentId = "pi_modification_1";
  input.modification.stripeChargeId = "ch_modification_1";
  input.modification.stripeTransferId = null;
  input.modification.stripeApplicationFeeId = "fee_modification_1";
  input.modification.stripePaymentStatus = "paid";

  const plan = buildGuestReservationModificationApplyPlan(input);

  assert.equal(plan.proposedTotalAmount, 600);
  assert.equal(plan.proposedPricingAmountDifference, 100);
  assert.equal(plan.nextAmountCollected, 600);
  assert.equal(plan.nextPlatformFeeAmount, 60);
  assert.equal(plan.nextHostPayoutAmount, 540);
});

test("rejects an additional payment without independent Stripe references", () => {
  const input = createInput();
  input.modification.financialAction =
    ReservationModificationFinancialAction.ADDITIONAL_PAYMENT_REQUIRED;
  input.modification.proposedTotalAmount = 600;
  input.modification.amountDifference = 100;
  input.modification.additionalChargeAmount = 100;
  input.modification.additionalPlatformFeeAmount = 10;
  input.modification.additionalHostPayoutAmount = 90;
  input.modification.stripeConnectedAccountId = "acct_host_1";
  input.modification.stripeCheckoutSessionId = "cs_modification_1";
  input.modification.stripePaymentIntentId = "pi_modification_1";
  input.modification.stripePaymentStatus = "paid";

  assert.throws(
    () => buildGuestReservationModificationApplyPlan(input),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "RESERVATION_MODIFICATION_PAYMENT_EVIDENCE_INCOMPLETE"
      );
      return true;
    }
  );
});

test("requires the durable no-refund reduction confirmation", () => {
  const input = createInput();
  input.modification.financialAction =
    ReservationModificationFinancialAction.NO_REFUND_DUE_CONFIRMATION_REQUIRED;
  input.modification.proposedTotalAmount = 400;
  input.modification.amountDifference = -100;

  assert.throws(
    () => buildGuestReservationModificationApplyPlan(input),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "NO_REFUND_REDUCTION_CONFIRMATION_REQUIRED"
      );
      return true;
    }
  );
});

test("persists ARI intent and APPLIED state inside the canonical transaction", () => {
  const source = readFileSync(
    "src/services/guest-reservation-modification-apply.service.ts",
    "utf8"
  );

  assert.match(source, /await prisma\.\$transaction\(/);
  assert.match(
    source,
    /await persistChannexAriReservationIntent\(\{\s*db: tx,/
  );
  assert.match(
    source,
    /await tx\.reservationModification\.update\(\{[\s\S]*status: ReservationModificationStatus\.APPLIED/
  );
});

test("reconciles only after commit and never calls TTLock directly", () => {
  const source = readFileSync(
    "src/services/guest-reservation-modification-apply.service.ts",
    "utf8"
  );
  const transactionEnd = source.indexOf(
    "isolationLevel: Prisma.TransactionIsolationLevel.Serializable"
  );
  const reconcileCall = source.indexOf(
    "await reconcileReservation(result.reservation.id)"
  );

  assert.ok(transactionEnd >= 0);
  assert.ok(reconcileCall > transactionEnd);
  assert.doesNotMatch(
    source,
    /ttlock|activateGrant|deactivateGrant|ttlockChangePasscode/i
  );
});

test("preserves the previous stay as the access reconciliation baseline", () => {
  const source = readFileSync(
    "src/services/guest-reservation-modification-apply.service.ts",
    "utf8"
  );

  assert.match(
    source,
    /\.\.\.\(plan\.datesChanged[\s\S]*lastReconciledCheckIn:\s*modification\.reservation\.lastReconciledCheckIn \?\?\s*modification\.currentCheckIn/
  );
  assert.match(
    source,
    /lastReconciledCheckOut:\s*modification\.reservation\.lastReconciledCheckOut \?\?\s*modification\.currentCheckOut/
  );
  assert.match(source, /lastHardwareSyncAt: null/);
});

function inStayInput() {
  const input = createInput();
  input.now = new Date("2026-10-12T12:00:00Z");
  input.modification.proposedCheckOut = new Date("2026-10-16T15:00:00Z");
  input.modification.guestConfirmation = {
    confirmed: true, source: "PIN_AI_GUEST_SERVICES", operation: "EXTEND_CHECKOUT_ONLY",
    confirmedAt: "2026-10-12T11:00:00Z", actionProposalConfirmedAt: "2026-10-12T10:59:00Z",
    actionProposalId: "proposal-test-12345678", actionProposalFingerprint: "a".repeat(64),
    expectedPreviewFingerprint: "b".repeat(64), confirmedPreviewFingerprint: "b".repeat(64),
  };
  return input;
}

test("confirmed in-stay extension checks only the added interval and retains check-in and guest configuration", () => {
  const input = inStayInput();
  const plan = buildGuestReservationModificationApplyPlan(input);
  assert.equal(plan.availabilityCheckIn.getTime(), input.reservation.checkOut.getTime());
  assert.equal(plan.guestsChanged, false);
  assert.equal(plan.amenitiesChanged, false);
  assert.equal(plan.nextAmountCollected, 500);
});

test("paid in-stay extension still requires complete payment evidence and exact financial split", () => {
  const input = inStayInput();
  input.modification.financialAction = ReservationModificationFinancialAction.ADDITIONAL_PAYMENT_REQUIRED;
  input.modification.proposedTotalAmount = 600;
  input.modification.amountDifference = 100;
  input.modification.additionalChargeAmount = 100;
  input.modification.additionalPlatformFeeAmount = 10;
  input.modification.additionalHostPayoutAmount = 90;
  assert.throws(() => buildGuestReservationModificationApplyPlan(input), /additional payment is not ready/);
  Object.assign(input.modification, {
    stripeConnectedAccountId: "acct_host_1", stripeCheckoutSessionId: "cs_test", stripePaymentIntentId: "pi_test",
    stripeChargeId: "ch_test", stripeApplicationFeeId: "fee_test", stripePaymentStatus: "paid",
  });
  const plan = buildGuestReservationModificationApplyPlan(input);
  assert.equal(plan.nextAmountCollected, 600);
  assert.equal(plan.nextPlatformFeeAmount, 60);
  assert.equal(plan.nextHostPayoutAmount, 540);
  input.modification.additionalHostPayoutAmount = 89;
  assert.throws(() => buildGuestReservationModificationApplyPlan(input), /split is invalid/);
});

for (const scenario of ["missing proposal", "wrong source", "changed fingerprint", "future confirmation", "changed check-in", "changed guests", "changed amenities", "ended stay", "shortened stay", "missing operation"] as const) {
  test(`in-stay application rejects ${scenario}`, () => {
    const input = inStayInput();
    const evidence = input.modification.guestConfirmation as Record<string, unknown>;
    if (scenario === "missing proposal") delete evidence.actionProposalId;
    if (scenario === "wrong source") evidence.source = "GUEST_MANAGE_RESERVATION";
    if (scenario === "changed fingerprint") evidence.confirmedPreviewFingerprint = "c".repeat(64);
    if (scenario === "future confirmation") evidence.confirmedAt = "2026-10-13T00:00:00Z";
    if (scenario === "changed check-in") input.modification.proposedCheckIn = new Date("2026-10-11T20:00:00Z");
    if (scenario === "changed guests") input.modification.proposedAdults = 3;
    if (scenario === "changed amenities") input.modification.proposedSelectedAmenityIds = [];
    if (scenario === "ended stay") input.now = input.reservation.checkOut;
    if (scenario === "shortened stay") input.modification.proposedCheckOut = new Date("2026-10-14T15:00:00Z");
    if (scenario === "missing operation") delete evidence.operation;
    assert.throws(() => buildGuestReservationModificationApplyPlan(input));
  });
}
