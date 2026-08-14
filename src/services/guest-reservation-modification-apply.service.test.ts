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

function createInput() {
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
  input.modification.stripeTransferId = "tr_modification_1";
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
