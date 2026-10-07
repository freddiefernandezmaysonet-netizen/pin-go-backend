import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import { certifyPinAIConnectDebit } from "./certify-pin-ai-connect-debit-sandbox.js";

function fixture(available = 500) {
  let debits = 0, funding = 0;
  const requests = new Map<string, unknown>();
  const account = { country: "US", default_currency: "usd", controller: { losses: { payments: "application" } } };
  const stripe = { accounts: { retrieve: async (id?: string) => id ? account : { id: "acct_1SmdRdRzkK1jKKf3" } },
    balance: { retrieve: async (_args: unknown, options: { stripeAccount: string }) => {
      assert.equal(options.stripeAccount, "acct_1UMuCTRzkKtvlWsd");
      return { livemode: false, available: [{ amount: available, currency: "usd" }], pending: [] };
    } }, charges: { create: async (params: any, options: any) => {
      if (params.source === "tok_bypassPending") { funding++; return { id: "ch_funding", livemode: false, paid: true }; }
      assert.equal(params.source, "acct_1UMuCTRzkKtvlWsd");
      assert.equal(params.amount, 100); assert.equal(options.stripeAccount, undefined);
      if (requests.has(options.idempotencyKey)) return requests.get(options.idempotencyKey);
      debits++; available -= 100;
      const result = { id: "py_test", object: "charge", source: params.source, livemode: false, paid: true, status: "succeeded",
        amount: 100, currency: "usd", metadata: params.metadata };
      requests.set(options.idempotencyKey, result); return result;
    } } } as unknown as Stripe;
  return { stripe, account, counts: () => ({ debits, funding }) };
}
test("account debit uses Connect as source and stable retry preserves one dollar balance change", async () => {
  const h = fixture(); const result = await certifyPinAIConnectDebit(h.stripe);
  assert.equal(result.certified, true); assert.equal(result.beforeDebitCents, 500);
  assert.equal(result.afterReplayCents, 400); assert.deepEqual(h.counts(), { debits: 1, funding: 0 });
});
test("unsupported negative balance responsibility prevents any debit", async () => {
  const h = fixture(); h.account.controller.losses.payments = "stripe";
  await assert.rejects(certifyPinAIConnectDebit(h.stripe));
  assert.deepEqual(h.counts(), { debits: 0, funding: 0 });
});
test("funding without available balance never permits an account debit", async () => {
  const h = fixture(0);
  await assert.rejects(certifyPinAIConnectDebit(h.stripe), /No available test funds/);
  assert.deepEqual(h.counts(), { debits: 0, funding: 1 });
});
