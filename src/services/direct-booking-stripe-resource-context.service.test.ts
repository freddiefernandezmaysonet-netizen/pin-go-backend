import assert from "node:assert/strict";
import test from "node:test";
import {
  isStripeResourceMissingError,
  retrieveDirectBookingCheckoutSession,
  retrieveDirectBookingPaymentIntent,
} from "./direct-booking-stripe-resource-context.service.js";

function resourceMissing() {
  return Object.assign(new Error("No such resource"), {
    code: "resource_missing",
    statusCode: 404,
  });
}

test("resource missing detection recognizes Stripe missing-resource shapes", () => {
  assert.equal(isStripeResourceMissingError(resourceMissing()), true);
  assert.equal(
    isStripeResourceMissingError({ raw: { code: "resource_missing" } }),
    true
  );
  assert.equal(isStripeResourceMissingError(new Error("network")), false);
});

test("checkout lookup uses platform context for legacy destination charges", async () => {
  const calls: unknown[] = [];
  const session = { id: "cs_legacy" } as any;
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
    sessionId: "cs_legacy",
    connectedAccountId: "acct_host",
  });

  assert.equal(result.session, session);
  assert.equal(result.chargeMode, "DESTINATION_CHARGE");
  assert.equal(result.stripeAccount, null);
  assert.deepEqual(calls, [["cs_legacy"]]);
});

test("checkout lookup retries in connected account for direct charges", async () => {
  const calls: unknown[] = [];
  const session = { id: "cs_direct" } as any;
  const stripeClient = {
    checkout: {
      sessions: {
        retrieve: async (...args: unknown[]) => {
          calls.push(args);
          if (args.length === 1) throw resourceMissing();
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

  assert.equal(result.chargeMode, "DIRECT_CHARGE");
  assert.equal(result.stripeAccount, "acct_host");
  assert.deepEqual(calls, [
    ["cs_direct"],
    ["cs_direct", { stripeAccount: "acct_host" }],
  ]);
});

test("checkout lookup never falls back on non-resource Stripe errors", async () => {
  const stripeClient = {
    checkout: {
      sessions: {
        retrieve: async () => {
          throw Object.assign(new Error("rate limited"), { statusCode: 429 });
        },
      },
    },
  };

  await assert.rejects(
    retrieveDirectBookingCheckoutSession({
      stripeClient,
      sessionId: "cs_direct",
      connectedAccountId: "acct_host",
    }),
    /rate limited/
  );
});

test("payment intent lookup preserves expand params and retries connected account", async () => {
  const calls: unknown[] = [];
  const paymentIntent = { id: "pi_direct" } as any;
  const stripeClient = {
    paymentIntents: {
      retrieve: async (...args: unknown[]) => {
        calls.push(args);
        if (args.length < 3) throw resourceMissing();
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
    ["pi_direct", params],
    ["pi_direct", params, { stripeAccount: "acct_host" }],
  ]);
});

test("missing or invalid connected account does not mask a platform lookup failure", async () => {
  const stripeClient = {
    paymentIntents: {
      retrieve: async () => {
        throw resourceMissing();
      },
    },
  };

  await assert.rejects(
    retrieveDirectBookingPaymentIntent({
      stripeClient,
      paymentIntentId: "pi_direct",
      connectedAccountId: "invalid",
    }),
    /No such resource/
  );
});
