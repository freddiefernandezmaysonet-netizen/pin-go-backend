import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import { certifyPinAIConnectReconciliation } from "./certify-pin-ai-connect-reconciliation-sandbox.js";

test("certificate reads the existing sandbox debit and has no write-capable method", async () => {
  const original = { id: "py_1UNdO4RzkK1jKKf3MupiM9op", object: "charge", amount: 100, currency: "usd",
    paid: true, status: "succeeded", created: 1791312413, livemode: false,
    source: "acct_1UMuCTRzkKtvlWsd", metadata: { pinAIReservationId: "qa-pin-ai-connect-20261006-v1" } };
  const stripe = { accounts: { retrieve: async () => ({ id: "acct_1SmdRdRzkK1jKKf3" }) },
    charges: { retrieve: async () => original },
    balance: { retrieve: async () => ({ livemode: false, available: [{ currency: "usd", amount: 400 }] }) },
    balanceTransactions: { list: async () => ({ data: [{ id: "txn_original", source: original.id }], has_more: false }) },
  } as unknown as Stripe;
  const result = await certifyPinAIConnectReconciliation(stripe, new Date("2026-10-06T20:00:00Z"));
  assert.equal(result.certified, true); assert.equal(result.balanceUnchanged, true);
  assert.equal(result.productionLedgerCertified, false);
});
test("certificate rejects any other platform before looking up payments", async () => {
  const stripe = { accounts: { retrieve: async () => ({ id: "acct_other" }) } } as unknown as Stripe;
  await assert.rejects(certifyPinAIConnectReconciliation(stripe));
});
