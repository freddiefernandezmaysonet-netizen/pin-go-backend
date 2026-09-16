import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  new URL("./direct-booking-refund.service.ts", import.meta.url),
  "utf8"
);

test("Direct Booking refund service is wired through the charge-mode adapter", () => {
  assert.match(
    source,
    /import \{ createDirectBookingStripeRefund \} from "\.\/direct-booking-stripe-refund\.service\.js";/
  );
  assert.match(
    source,
    /createDirectBookingStripeRefund\(\{[\s\S]*?stripeClient: stripe,[\s\S]*?connectedAccountId: reservation\.stripeConnectedAccountId,[\s\S]*?payment_intent: reservation\.stripePaymentIntentId,[\s\S]*?reverse_transfer: true,[\s\S]*?refund_application_fee: refundApplicationFee,[\s\S]*?options: \{[\s\S]*?idempotencyKey: refundIdempotencyKey/
  );
});

test("Direct Booking refund audit records the resolved Stripe charge mode", () => {
  assert.match(
    source,
    /reverseTransfer: stripeRefundResult\.reverseTransfer/
  );
  assert.match(
    source,
    /stripeChargeMode: stripeRefundResult\.chargeMode/
  );
  assert.match(
    source,
    /stripeAccount: stripeRefundResult\.stripeAccount/
  );
});

test("legacy direct Stripe refund call is no longer invoked directly by the service", () => {
  assert.doesNotMatch(
    source,
    /const refund = await stripe\.refunds\.create\(/
  );
});
