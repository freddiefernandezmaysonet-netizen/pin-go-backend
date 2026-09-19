import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  new URL("./direct-booking-refund.service.ts", import.meta.url),
  "utf8"
);

test("Direct Booking refund service is wired through the Direct Charge adapter", () => {
  assert.match(
    source,
    /import \{ createDirectBookingStripeRefund \} from "\.\/direct-booking-stripe-refund\.service\.js";/
  );
  assert.match(
    source,
    /createDirectBookingStripeRefund\(\{[\s\S]*?stripeClient: stripe,[\s\S]*?connectedAccountId: reservation\.stripeConnectedAccountId,[\s\S]*?payment_intent: reservation\.stripePaymentIntentId,[\s\S]*?refund_application_fee: refundApplicationFee,[\s\S]*?options: \{[\s\S]*?idempotencyKey: refundIdempotencyKey/
  );
  assert.doesNotMatch(source, /reverse_transfer\s*:/);
});

test("Direct Booking refund audit records Direct Charge scope", () => {
  assert.match(
    source,
    /stripeChargeMode: stripeRefundResult\.chargeMode/
  );
  assert.match(
    source,
    /stripeAccount: stripeRefundResult\.stripeAccount/
  );
  assert.match(
    source,
    /reverseTransfer: stripeRefundResult\.reverseTransfer/
  );
});

test("Stripe refunds are invoked only through the scoped adapter", () => {
  assert.doesNotMatch(
    source,
    /const refund = await stripe\.refunds\.create\(/
  );
});
