import assert from "node:assert/strict";
import test from "node:test";
import {
  retrieveDirectBookingCheckoutSession,
  retrieveDirectBookingPaymentIntent,
} from "./direct-booking-stripe-resource-context.service.js";

test("checkout lookup is always scoped to the connected account", async () => {
  const calls: unknown[] = [];
  const session = { id: "cs_direct" } as any;
  const stripeClient = {
    checkout: {
      sessions: {
        retrieve: async (...args: unknown[]) => {
          calls.push(args);
          return session;
        },
      },
    },
  };

  const result = await retrieveDirectBookingCheckoutSession({
    stripeClient,
    sessionId: "cs_direct",
    connectedAccountId: "acct_host",
  });

  assert.equal(result.session, session);
  assert.equal(result.chargeMode, "DIRECT_CHARGE");
  assert.equal(result.stripeAccount, "acct_host");
  assert.deepEqual(calls, [
    ["cs_direct", { stripeAccount: "acct_host" }],
  ]);
});

test("payment intent lookup preserves expand params and uses connected account scope", async () => {
  const calls: unknown[] = [];
  const paymentIntent = { id: "pi_direct" } as any;
  const stripeClient = {
    paymentIntents: {
      retrieve: async (...args: unknown[]) => {
        calls.push(args);
        return paymentIntent;
      },
    },
  };
  const params = { expand: ["latest_charge"] };

  const result = await retrieveDirectBookingPaymentIntent({
    stripeClient,
    paymentIntentId: "pi_direct",
    connectedAccountId: "acct_host",
    params,
  });

  assert.equal(result.paymentIntent, paymentIntent);
  assert.equal(result.chargeMode, "DIRECT_CHARGE");
  assert.equal(result.stripeAccount, "acct_host");
  assert.deepEqual(calls, [
    ["pi_direct", params, { stripeAccount: "acct_host" }],
  ]);
});

test("checkout lookup fails closed before Stripe without a valid connected account", async () => {
  let calls = 0;
  const stripeClient = {
    checkout: {
      sessions: {
        retrieve: async () => {
          calls += 1;
          return { id: "cs_should_not_exist" } as any;
        },
      },
    },
  };

  await assert.rejects(
    retrieveDirectBookingCheckoutSession({
      stripeClient,
      sessionId: "cs_direct",
      connectedAccountId: null,
    }),
    /DIRECT_BOOKING_STRIPE_CONNECTED_ACCOUNT_INVALID/
  );
  assert.equal(calls, 0);
});

test("payment intent lookup fails closed before Stripe without a valid connected account", async () => {
  let calls = 0;
  const stripeClient = {
    paymentIntents: {
      retrieve: async () => {
        calls += 1;
        return { id: "pi_should_not_exist" } as any;
      },
    },
  };

  await assert.rejects(
    retrieveDirectBookingPaymentIntent({
      stripeClient,
      paymentIntentId: "pi_direct",
      connectedAccountId: "invalid",
    }),
    /DIRECT_BOOKING_STRIPE_CONNECTED_ACCOUNT_INVALID/
  );
  assert.equal(calls, 0);
});
