import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import { DamageCasePaymentAttemptStatus } from "@prisma/client";
import {
  buildDamagePaymentIntentRequest,
  damageCasePaymentAttemptStatusFromPaymentIntent,
} from "./damage-case-payment-execution.service.js";

function paymentIntent(status: Stripe.PaymentIntent.Status) {
  return { id: "pi_damage_1", status } as Stripe.PaymentIntent;
}

test("builds one exact off-session Direct Charge with the saved card", () => {
  const request = buildDamagePaymentIntentRequest({
    amountMinor: 12345,
    currency: "usd",
    customerId: "cus_guest",
    paymentMethodId: "pm_saved",
    connectedAccountId: "acct_host",
    idempotencyKey: "pingo_pp_charge_v1_exact",
    organizationId: "org_1",
    reservationId: "res_1",
    reservationNumber: "PG-2026-000123",
    damageCaseId: "damage_1",
    paymentAuthorizationId: "authorization_1",
    claimRevision: "a".repeat(64),
  });

  assert.deepEqual(request.options, {
    stripeAccount: "acct_host",
    idempotencyKey: "pingo_pp_charge_v1_exact",
  });
  assert.equal(request.params.amount, 12345);
  assert.equal(request.params.currency, "usd");
  assert.equal(request.params.customer, "cus_guest");
  assert.equal(request.params.payment_method, "pm_saved");
  assert.equal(request.params.off_session, true);
  assert.equal(request.params.confirm, true);
  assert.equal(request.params.metadata?.damageCaseId, "damage_1");
  assert.equal(request.params.metadata?.claimRevision, "a".repeat(64));
  assert.equal("application_fee_amount" in request.params, false);
  assert.equal("payment_method_types" in request.params, false);
  assert.equal("capture_method" in request.params, false);
});

test("maps Stripe outcomes without treating processing or action as success", () => {
  assert.equal(
    damageCasePaymentAttemptStatusFromPaymentIntent(paymentIntent("succeeded")),
    DamageCasePaymentAttemptStatus.SUCCEEDED
  );
  assert.equal(
    damageCasePaymentAttemptStatusFromPaymentIntent(paymentIntent("processing")),
    DamageCasePaymentAttemptStatus.PROCESSING
  );
  assert.equal(
    damageCasePaymentAttemptStatusFromPaymentIntent(paymentIntent("requires_action")),
    DamageCasePaymentAttemptStatus.REQUIRES_ACTION
  );
  assert.equal(
    damageCasePaymentAttemptStatusFromPaymentIntent(paymentIntent("requires_payment_method")),
    DamageCasePaymentAttemptStatus.FAILED
  );
  assert.equal(
    damageCasePaymentAttemptStatusFromPaymentIntent(paymentIntent("canceled")),
    DamageCasePaymentAttemptStatus.CANCELED
  );
});
