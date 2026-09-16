import assert from "node:assert/strict";
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

test("Direct Booking Stripe charge mode defaults to destination charge", () => {
  assert.equal(
    resolveDirectBookingStripeChargeMode({}),
    "DESTINATION_CHARGE"
  );
});

test("Direct Booking Stripe charge mode enables direct charges only when explicitly true", () => {
  assert.equal(
    resolveDirectBookingStripeChargeMode({
      DIRECT_BOOKING_STRIPE_DIRECT_CHARGES_ENABLED: "true",
    }),
    "DIRECT_CHARGE"
  );
  assert.equal(
    resolveDirectBookingStripeChargeMode({
      DIRECT_BOOKING_STRIPE_DIRECT_CHARGES_ENABLED: "false",
    }),
    "DESTINATION_CHARGE"
  );
});

test("destination charge checkout preserves transfer_data destination", () => {
  const context = buildDirectBookingCheckoutStripeContext({
    connectedAccountId,
    paymentIntentData: {
      application_fee_amount: 125,
      metadata: { flow: "direct_booking" },
    },
    env: {},
  });

  assert.equal(context.chargeMode, "DESTINATION_CHARGE");
  assert.equal(
    context.paymentIntentData.transfer_data?.destination,
    connectedAccountId
  );
  assert.equal(context.paymentIntentData.application_fee_amount, 125);
  assert.equal(context.requestOptions, undefined);
});

test("direct charge checkout removes transfer_data and targets connected account", () => {
  const context = buildDirectBookingCheckoutStripeContext({
    connectedAccountId,
    paymentIntentData: {
      application_fee_amount: 125,
      transfer_data: { destination: connectedAccountId },
      metadata: { flow: "direct_booking" },
    },
    env: {
      DIRECT_BOOKING_STRIPE_DIRECT_CHARGES_ENABLED: "true",
    },
  });

  assert.equal(context.chargeMode, "DIRECT_CHARGE");
  assert.equal(context.paymentIntentData.transfer_data, undefined);
  assert.equal(context.paymentIntentData.application_fee_amount, 125);
  assert.deepEqual(context.requestOptions, {
    stripeAccount: connectedAccountId,
  });
});

test("direct charge object reads target connected account", () => {
  assert.deepEqual(
    buildDirectBookingStripeObjectRequestOptions({
      connectedAccountId,
      chargeMode: "DIRECT_CHARGE",
    }),
    { stripeAccount: connectedAccountId }
  );
  assert.equal(
    buildDirectBookingStripeObjectRequestOptions({
      connectedAccountId,
      chargeMode: "DESTINATION_CHARGE",
    }),
    undefined
  );
});

test("refund context uses reverse_transfer only for destination charges", () => {
  const destination = buildDirectBookingRefundStripeContext({
    connectedAccountId,
    chargeMode: "DESTINATION_CHARGE",
    refundApplicationFee: true,
  });
  assert.deepEqual(destination.params, {
    reverse_transfer: true,
    refund_application_fee: true,
  });
  assert.equal(destination.requestOptions, undefined);

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

test("charge mode is persisted and defaults legacy reservations to destination charge", () => {
  assert.deepEqual(directBookingStripeChargeModeMetadata("DIRECT_CHARGE"), {
    stripeChargeMode: "DIRECT_CHARGE",
  });
  assert.equal(
    resolveDirectBookingChargeModeFromMetadata({
      stripeChargeMode: "DIRECT_CHARGE",
    }),
    "DIRECT_CHARGE"
  );
  assert.equal(
    resolveDirectBookingChargeModeFromMetadata(undefined),
    "DESTINATION_CHARGE"
  );
});
