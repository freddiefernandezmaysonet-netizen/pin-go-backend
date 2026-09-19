import assert from "node:assert/strict";
import test from "node:test";
import { createDirectBookingStripeRefund } from "./direct-booking-stripe-refund.service.js";

test("Direct Charge refund is created directly in the connected account", async () => {
  const calls: unknown[] = [];
  const refund = { id: "re_direct" } as any;
  const stripeClient = {
    refunds: {
      create: async (...args: unknown[]) => {
        calls.push(args);
        return refund;
      },
    },
  };
  const params = {
    payment_intent: "pi_direct",
    amount: 1000,
    refund_application_fee: true,
    metadata: { reservationId: "res_123" },
  };
  const options = { idempotencyKey: "refund:direct" };

  const result = await createDirectBookingStripeRefund({
    stripeClient,
    params,
    options,
    connectedAccountId: "acct_host",
  });

  assert.equal(result.refund, refund);
  assert.equal(result.chargeMode, "DIRECT_CHARGE");
  assert.equal(result.reverseTransfer, false);
  assert.equal(result.stripeAccount, "acct_host");
  assert.deepEqual(calls, [
    [
      params,
      {
        idempotencyKey: "refund:direct",
        stripeAccount: "acct_host",
      },
    ],
  ]);
});

test("Direct Charge refund preserves application fee refund semantics", async () => {
  const refund = { id: "re_direct" } as any;
  const stripeClient = {
    refunds: {
      create: async (
        params: Record<string, unknown>,
        options?: Record<string, unknown>
      ) => {
        assert.equal(params.refund_application_fee, true);
        assert.equal("reverse_transfer" in params, false);
        assert.equal(options?.stripeAccount, "acct_host");
        return refund;
      },
    },
  };

  await createDirectBookingStripeRefund({
    stripeClient,
    params: {
      payment_intent: "pi_direct",
      amount: 500,
      refund_application_fee: true,
    },
    connectedAccountId: "acct_host",
  });
});

test("Stripe errors are not retried through the platform account", async () => {
  let calls = 0;
  const stripeClient = {
    refunds: {
      create: async () => {
        calls += 1;
        throw Object.assign(new Error("rate limited"), { statusCode: 429 });
      },
    },
  };

  await assert.rejects(
    createDirectBookingStripeRefund({
      stripeClient,
      params: {
        payment_intent: "pi_direct",
        amount: 1000,
      },
      connectedAccountId: "acct_host",
    }),
    /rate limited/
  );
  assert.equal(calls, 1);
});

test("missing connected account fails closed before Stripe is called", async () => {
  let calls = 0;
  const stripeClient = {
    refunds: {
      create: async () => {
        calls += 1;
        return { id: "re_should_not_exist" } as any;
      },
    },
  };

  await assert.rejects(
    createDirectBookingStripeRefund({
      stripeClient,
      params: {
        payment_intent: "pi_direct",
        amount: 1000,
      },
      connectedAccountId: null,
    }),
    /DIRECT_BOOKING_STRIPE_CONNECTED_ACCOUNT_INVALID/
  );
  assert.equal(calls, 0);
});
