import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import type { PinAIReservationFee } from "@prisma/client";
import { createPinAIConnectStripeProvider } from "./fee-connect-stripe.provider.js";
import { ConnectDebitInsufficientBalanceError } from "./fee-connect.service.js";
const fee = { reservationId: "r", organizationId: "o", propertyId: "p", termsVersion: "t",
  amountCents: 100, stripeConnectedAccountId: "acct_host" } as PinAIReservationFee;
test("SDK legacy Payment response stays scoped to Connect source, while pending funds are excluded", async () => {
  const stripe = { accounts: { retrieve: async () => ({ country: "US", default_currency: "usd",
    controller: { losses: { payments: "application" } } }) },
    balance: { retrieve: async (_: unknown, opts: any) => {
      assert.equal(opts.stripeAccount, "acct_host");
      return { available: [{ currency: "usd", amount: 0 }], pending: [{ currency: "usd", amount: 2400 }] };
    } }, charges: { create: async (params: any, opts: any) => {
      assert.equal(params.source, "acct_host"); assert.equal(params.amount, 100);
      assert.deepEqual(opts, { idempotencyKey: "stable-key" });
      return { id: "py_legacy", object: "charge", source: { id: "acct_host", object: "account" },
        amount: 100, currency: "usd", paid: true, status: "succeeded", metadata: params.metadata };
    } } } as unknown as Stripe;
  const provider = createPinAIConnectStripeProvider(stripe);
  assert.deepEqual(await provider.eligibility("acct_host"), { compatible: true, availableCents: 0 });
  assert.equal((await provider.create(fee, "stable-key")).accountId, "acct_host");
});
test("only a definitive Stripe no-balance rejection retires a debit key", async () => {
  let error: unknown = { type: "StripeInvalidRequestError", code: "balance_insufficient" };
  const provider = createPinAIConnectStripeProvider({ charges: { create: async () => { throw error; } } } as unknown as Stripe);
  await assert.rejects(provider.create(fee, "key"), ConnectDebitInsufficientBalanceError);
  error = { type: "StripeAPIError", code: "balance_insufficient" };
  try { await provider.create(fee, "key"); assert.fail("expected rejection"); }
  catch (actual) { assert.equal(actual, error); }
});
test("incompatible country or liability never reads balance", async () => {
  const provider = createPinAIConnectStripeProvider({
    accounts: { retrieve: async () => ({ country: "US", default_currency: "usd",
      controller: { losses: { payments: "stripe" } } }) },
    balance: { retrieve: async () => { throw Error("unexpected balance call"); } },
  } as unknown as Stripe);
  assert.deepEqual(await provider.eligibility("acct_host"), { compatible: false, availableCents: 0 });
});

test("expired reconciliation paginates platform payment history and ignores other reservations", async () => {
  let pages = 0;
  const provider = createPinAIConnectStripeProvider({
    balanceTransactions: { list: async (params: any) => {
      assert.equal(params.type, "payment"); assert.equal(params.currency, "usd");
      assert.equal(params.created.gte, 1000 - 60);
      pages++;
      if (pages === 1) return { data: [{ id: "txn_first", source: "py_other" }], has_more: true };
      assert.equal(params.starting_after, "txn_first");
      return { data: [{ id: "txn_second", source: { id: "py_match" } }], has_more: false };
    } },
    charges: { retrieve: async (id: string) => ({ id, object: "charge", source: "acct_host", amount: 100,
      currency: "usd", paid: true, status: "succeeded", metadata: { pinAIReservationId: id === "py_match" ? "r" : "other" } }) },
  } as unknown as Stripe);
  const result = await provider.reconcile!({ ...fee, debitStartedAt: new Date(1000000) }, new Date(2000000));
  assert.equal(result.complete, true); assert.equal(result.payments.length, 1); assert.equal(result.payments[0].id, "py_match");
  assert.equal(pages, 2);
});
test("bounded history scan reports incomplete instead of assuming uniqueness", async () => {
  const provider = createPinAIConnectStripeProvider({
    balanceTransactions: { list: async () => ({ data: Array.from({ length: 21 }, (_, i) => ({ id: `txn_${i}`, source: `py_${i}` })), has_more: false }) },
    charges: { retrieve: async (id: string) => ({ id, object: "charge", source: "acct_host", amount: 100,
      currency: "usd", paid: true, status: "succeeded", metadata: { pinAIReservationId: "other" } }) },
  } as unknown as Stripe);
  assert.equal((await provider.reconcile!({ ...fee, debitStartedAt: new Date(1000000) }, new Date(2000000))).complete, false);
});
