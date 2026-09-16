import assert from "node:assert/strict";
import test from "node:test";
import { createDirectBookingStripeRefund } from "./direct-booking-stripe-refund.service.js";

function resourceMissing() {
  return Object.assign(new Error("No such payment_intent"), {
    code: "resource_missing",
    statusCode: 404,
  });
}

test("legacy destination refund is sent unchanged and is not retried", async () => {
  const calls: unknown[] = [];
  const refund = { id: "re_legacy" } as any;
  const stripeClient = {
    refunds: {
      create: async (...args: unknown[]) => {
        calls.push(args);
        return refund;
      },
    },
  };
  const params = {
    payment_intent: "pi_legacy",
    amount: 1000,
    reverse_transfer: true,
    refund_application_fee: true,
  };
  const options = { idempotencyKey: "refund:legacy" };

  const result = await createDirectBookingStripeRefund({
    stripeClient,
    params,
    options,
    connectedAccountId: "acct_host",
  });

  assert.equal(result.refund, refund);
  assert.equal(result.chargeMode, "DESTINATION_CHARGE");
  assert.equal(result.reverseTransfer, true);
  assert.equal(result.stripeAccount, null);
  assert.deepEqual(calls, [[params, options]]);
});

test("direct charge refund retries in connected account without reverse_transfer", async () => {
  const calls: unknown[] = [];
  const refund = { id: "re_direct" } as any;
  const stripeClient = {
    refunds: {
      create: async (...args: unknown[]) => {
        calls.push(args);
        if (calls.length === 1) throw resourceMissing();
        return refund;
      },
    },
  };
  const params = {
    payment_intent: "pi_direct",
    amount: 1000,
    reverse_transfer: true,
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

  const secondCall = calls[1] as [Record<string, unknown>, Record<string, unknown>];
  assert.equal("reverse_transfer" in secondCall[0], false);
  assert.equal(secondCall[0].refund_application_fee, true);
  assert.equal(secondCall[0].payment_intent, "pi_direct");
  assert.deepEqual(secondCall[1], {
    idempotencyKey: "refund:direct",
    stripeAccount: "acct_host",
  });
});

test("non-resource Stripe errors are never retried", async () => {
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
        reverse_transfer: true,
      },
      connectedAccountId: "acct_host",
    }),
    /rate limited/
  );
  assert.equal(calls, 1);
});

test("resource missing is not retried without a valid connected account", async () => {
  let calls = 0;
  const stripeClient = {
    refunds: {
      create: async () => {
        calls += 1;
        throw resourceMissing();
      },
    },
  };

  await assert.rejects(
    createDirectBookingStripeRefund({
      stripeClient,
      params: {
        payment_intent: "pi_direct",
        amount: 1000,
        reverse_transfer: true,
      },
      connectedAccountId: null,
    }),
    /No such payment_intent/
  );
  assert.equal(calls, 1);
});
