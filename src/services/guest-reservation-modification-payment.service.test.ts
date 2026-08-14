import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ReservationModificationFinancialAction,
} from "@prisma/client";
import type Stripe from "stripe";

process.env.STRIPE_SECRET_KEY ??= "sk_test_contract_only";

const { buildGuestReservationModificationPaidCheckoutContract } =
  await import("./guest-reservation-modification-payment.service");

function createModification() {
  return {
    id: "modification_001",
    reservationId: "reservation_001",
    financialAction:
      ReservationModificationFinancialAction.ADDITIONAL_PAYMENT_REQUIRED,
    currency: "USD",
    additionalChargeAmount: 100,
    additionalPlatformFeeAmount: 5,
    additionalHostPayoutAmount: 95,
    stripeConnectedAccountId: "acct_connected_001",
    stripeCheckoutSessionId: "cs_modification_001",
    reservation: {
      id: "reservation_001",
      propertyId: "property_001",
      stripeConnectedAccountId: "acct_connected_001",
    },
  };
}

function createSession(): Stripe.Checkout.Session {
  return {
    id: "cs_modification_001",
    payment_status: "paid",
    amount_total: 10_000,
    currency: "usd",
    client_reference_id: "modification_001",
    payment_intent: "pi_modification_001",
    metadata: {
      flow: "direct_booking_reservation_modification",
      reservationModificationId: "modification_001",
      reservationId: "reservation_001",
      propertyId: "property_001",
      connectedAccountId: "acct_connected_001",
      additionalChargeAmountCents: "10000",
      additionalPlatformFeeAmountCents: "500",
      additionalHostPayoutAmountCents: "9500",
    },
  } as Stripe.Checkout.Session;
}

function expectPaymentError(
  callback: () => unknown,
  expectedCode: string
) {
  assert.throws(callback, (error: unknown) => {
    assert.equal((error as { code?: string }).code, expectedCode);
    return true;
  });
}

test("accepts a paid Checkout only when identity, amounts and destination match", () => {
  const contract = buildGuestReservationModificationPaidCheckoutContract({
    session: createSession(),
    modification: createModification(),
  });

  assert.deepEqual(contract, {
    modificationId: "modification_001",
    reservationId: "reservation_001",
    propertyId: "property_001",
    connectedAccountId: "acct_connected_001",
    checkoutSessionId: "cs_modification_001",
    paymentIntentId: "pi_modification_001",
    currency: "usd",
    additionalChargeAmountCents: 10_000,
    additionalPlatformFeeAmountCents: 500,
    additionalHostPayoutAmountCents: 9_500,
  });
});

test("rejects a Checkout that has not reached paid status", () => {
  const session = createSession();
  session.payment_status = "unpaid";

  expectPaymentError(
    () =>
      buildGuestReservationModificationPaidCheckoutContract({
        session,
        modification: createModification(),
      }),
    "RESERVATION_MODIFICATION_PAYMENT_NOT_PAID"
  );
});

test("rejects any mismatch in the approved financial split", () => {
  const session = createSession();
  session.metadata!.additionalHostPayoutAmountCents = "9400";

  expectPaymentError(
    () =>
      buildGuestReservationModificationPaidCheckoutContract({
        session,
        modification: createModification(),
      }),
    "RESERVATION_MODIFICATION_PAYMENT_AMOUNT_MISMATCH"
  );
});

test("rejects a Checkout linked to another modification or session", () => {
  const session = createSession();
  session.client_reference_id = "modification_other";

  expectPaymentError(
    () =>
      buildGuestReservationModificationPaidCheckoutContract({
        session,
        modification: createModification(),
      }),
    "RESERVATION_MODIFICATION_PAYMENT_IDENTITY_MISMATCH"
  );
});

test("rejects a Connect destination different from the durable snapshot", () => {
  const session = createSession();
  session.metadata!.connectedAccountId = "acct_attacker";

  expectPaymentError(
    () =>
      buildGuestReservationModificationPaidCheckoutContract({
        session,
        modification: createModification(),
      }),
    "RESERVATION_MODIFICATION_PAYMENT_DESTINATION_MISMATCH"
  );
});

test("persists independent Stripe evidence before invoking the canonical applier", () => {
  const source = readFileSync(
    "src/services/guest-reservation-modification-payment.service.ts",
    "utf8"
  );

  assert.match(
    source,
    /status:\s*ReservationModificationStatus\.PAYMENT_PROCESSING/
  );
  assert.match(source, /stripe\.paymentIntents\.retrieve/);
  assert.match(source, /stripe\.transfers\.retrieve/);
  assert.match(source, /stripe\.applicationFees\.retrieve/);
  assert.match(source, /status:\s*ReservationModificationStatus\.APPLYING/);
  assert.match(source, /await applyGuestReservationModification\(/);
  assert.doesNotMatch(source, /ttlock/i);
});
