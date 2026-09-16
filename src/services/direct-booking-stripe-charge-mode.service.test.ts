import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  buildDirectBookingCheckoutStripeContext,
  buildDirectBookingRefundStripeContext,
  buildDirectBookingStripeObjectRequestOptions,
  directBookingDirectChargesAllowedForConnectedAccount,
  directBookingStripeChargeModeMetadata,
  resolveDirectBookingChargeModeFromMetadata,
  resolveDirectBookingStripeChargeMode,
} from "./direct-booking-stripe-charge-mode.service.js";

const connectedAccountId = "acct_123456789";
const stripeClientSource = fs.readFileSync(
  new URL("../billing/stripe.ts", import.meta.url),
  "utf8"
);

test("Direct Booking Stripe charge mode defaults to destination charge", () => {
  assert.equal(
    resolveDirectBookingStripeChargeMode({}, connectedAccountId),
    "DESTINATION_CHARGE"
  );
});

test("Direct Booking Direct Charges fail closed unless the connected account is allowlisted", () => {
  assert.equal(
    resolveDirectBookingStripeChargeMode(
      {
        DIRECT_BOOKING_STRIPE_DIRECT_CHARGES_ENABLED: "true",
      },
      connectedAccountId
    ),
    "DESTINATION_CHARGE"
  );

  assert.equal(
    resolveDirectBookingStripeChargeMode(
      {
        DIRECT_BOOKING_STRIPE_DIRECT_CHARGES_ENABLED: "true",
        DIRECT_BOOKING_STRIPE_DIRECT_CHARGES_CANARY_ACCOUNT_IDS:
          "acct_other",
      },
      connectedAccountId
    ),
    "DESTINATION_CHARGE"
  );

  assert.equal(
    resolveDirectBookingStripeChargeMode(
      {
        DIRECT_BOOKING_STRIPE_DIRECT_CHARGES_ENABLED: "true",
        DIRECT_BOOKING_STRIPE_DIRECT_CHARGES_CANARY_ACCOUNT_IDS:
          connectedAccountId,
      },
      connectedAccountId
    ),
    "DIRECT_CHARGE"
  );

  assert.equal(
    resolveDirectBookingStripeChargeMode(
      {
        DIRECT_BOOKING_STRIPE_DIRECT_CHARGES_ENABLED: "false",
        DIRECT_BOOKING_STRIPE_DIRECT_CHARGES_CANARY_ACCOUNT_IDS:
          connectedAccountId,
      },
      connectedAccountId
    ),
    "DESTINATION_CHARGE"
  );
});

test("Direct Booking Direct Charges can be explicitly expanded after canary with wildcard allowlist", () => {
  const env = {
    DIRECT_BOOKING_STRIPE_DIRECT_CHARGES_ENABLED: "true",
    DIRECT_BOOKING_STRIPE_DIRECT_CHARGES_CANARY_ACCOUNT_IDS: "*",
  };

  assert.equal(
    directBookingDirectChargesAllowedForConnectedAccount(
      connectedAccountId,
      env
    ),
    true
  );
  assert.equal(
    resolveDirectBookingStripeChargeMode(env, connectedAccountId),
    "DIRECT_CHARGE"
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

test("direct charge checkout removes transfer_data and targets allowlisted connected account", () => {
  const context = buildDirectBookingCheckoutStripeContext({
    connectedAccountId,
    paymentIntentData: {
      application_fee_amount: 125,
      transfer_data: { destination: connectedAccountId },
      metadata: { flow: "direct_booking" },
    },
    env: {
      DIRECT_BOOKING_STRIPE_DIRECT_CHARGES_ENABLED: "true",
      DIRECT_BOOKING_STRIPE_DIRECT_CHARGES_CANARY_ACCOUNT_IDS:
        connectedAccountId,
    },
  });

  assert.equal(context.chargeMode, "DIRECT_CHARGE");
  assert.equal(
    "transfer_data" in context.paymentIntentData
      ? context.paymentIntentData.transfer_data
      : undefined,
    undefined
  );
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

test("Stripe client keeps Direct Charges fenced behind the explicit feature flag", () => {
  assert.match(
    stripeClientSource,
    /flow !== "direct_booking" \|\|\s*!directBookingDirectChargesEnabled\(\)/
  );
  assert.match(
    stripeClientSource,
    /return originalCheckoutSessionCreate\(params, options\);/
  );
});

test("Stripe client does not migrate reservation modification checkout implicitly", () => {
  assert.match(
    stripeClientSource,
    /Direct Charges V1 is intentionally fenced to the initial Direct Booking/
  );
  assert.doesNotMatch(
    stripeClientSource,
    /flow === "direct_booking_reservation_modification"[\s\S]*?buildDirectBookingCheckoutStripeContext/
  );
});

test("Stripe client supports a separate Connect webhook secret only when Direct Charges are enabled", () => {
  assert.match(
    stripeClientSource,
    /STRIPE_CONNECT_WEBHOOK_SECRET/
  );
  assert.match(
    stripeClientSource,
    /!directBookingDirectChargesEnabled\(\) \|\|\s*!connectWebhookSecret/
  );
  assert.match(
    stripeClientSource,
    /connectArgs\[2\] = connectWebhookSecret/
  );
});

test("Stripe Connect webhook events are fenced to allowlisted canary accounts", () => {
  assert.match(
    stripeClientSource,
    /directBookingDirectChargesAllowedForConnectedAccount\(\s*connectedAccountId\s*\)/
  );
  assert.match(
    stripeClientSource,
    /CONNECT_CANARY_IGNORED_EVENT_TYPE\s*=\s*\n?\s*"pin_go\.connect_canary_ignored"/
  );
  assert.match(
    stripeClientSource,
    /\[STRIPE_CONNECT_CANARY_EVENT_IGNORED\]/
  );
  assert.match(
    stripeClientSource,
    /type:\s*CONNECT_CANARY_IGNORED_EVENT_TYPE/
  );
});
