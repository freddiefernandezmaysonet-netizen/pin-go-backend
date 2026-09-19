import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  buildDirectBookingCheckoutStripeContext,
  buildDirectBookingRefundStripeContext,
  buildDirectBookingStripeObjectRequestOptions,
  directBookingStripeChargeModeMetadata,
  resolveDirectBookingChargeModeFromMetadata,
  resolveDirectBookingStripeChargeMode,
} from "./direct-booking-stripe-charge-mode.service.js";

const connectedAccountId = "acct_123456789";
const stripeClientSource = fs.readFileSync(
  new URL("../billing/stripe.ts", import.meta.url),
  "utf8"
);

test("Direct Booking Stripe charge mode is always Direct Charge for a valid connected account", () => {
  assert.equal(
    resolveDirectBookingStripeChargeMode({}, connectedAccountId),
    "DIRECT_CHARGE"
  );
});

test("Direct Booking Stripe charge mode fails closed without a valid connected account", () => {
  assert.throws(
    () => resolveDirectBookingStripeChargeMode({}, null),
    /DIRECT_BOOKING_STRIPE_CONNECTED_ACCOUNT_INVALID/
  );
});

test("Direct Charge checkout targets the connected account and preserves application fee", () => {
  const context = buildDirectBookingCheckoutStripeContext({
    connectedAccountId,
    paymentIntentData: {
      application_fee_amount: 125,
      metadata: { flow: "direct_booking" },
    },
  });

  assert.equal(context.chargeMode, "DIRECT_CHARGE");
  assert.equal(context.paymentIntentData.application_fee_amount, 125);
  assert.deepEqual(context.requestOptions, {
    stripeAccount: connectedAccountId,
  });
});

test("Direct Charge object reads target connected account", () => {
  assert.deepEqual(
    buildDirectBookingStripeObjectRequestOptions({
      connectedAccountId,
      chargeMode: "DIRECT_CHARGE",
    }),
    { stripeAccount: connectedAccountId }
  );
});

test("Direct Charge refund remains connected-account scoped without reverse transfer", () => {
  const direct = buildDirectBookingRefundStripeContext({
    connectedAccountId,
    chargeMode: "DIRECT_CHARGE",
    refundApplicationFee: true,
  });

  assert.deepEqual(direct.params, {
    refund_application_fee: true,
  });
  assert.deepEqual(direct.requestOptions, {
    stripeAccount: connectedAccountId,
  });
});

test("charge mode metadata accepts only Direct Charge", () => {
  assert.deepEqual(directBookingStripeChargeModeMetadata("DIRECT_CHARGE"), {
    stripeChargeMode: "DIRECT_CHARGE",
  });
  assert.equal(
    resolveDirectBookingChargeModeFromMetadata({
      stripeChargeMode: "DIRECT_CHARGE",
    }),
    "DIRECT_CHARGE"
  );
  assert.throws(
    () => resolveDirectBookingChargeModeFromMetadata(undefined),
    /DIRECT_BOOKING_STRIPE_CHARGE_MODE_INVALID/
  );
});

test("Stripe client still contains no implicit migration assertion for reservation modifications until that file is migrated", () => {
  assert.match(
    stripeClientSource,
    /Direct Charges V1 is intentionally fenced to the initial Direct Booking/
  );
});
