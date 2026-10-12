import assert from "node:assert/strict";
import test from "node:test";
import { certifyPinAIHybridSandbox, HYBRID_SANDBOX_PLATFORM } from "./certify-pin-ai-hybrid-sandbox.js";
const run = "qa-pin-ai-hybrid-873251da-1151-43d9-8e6e-2b55c59c5cfe";
test("another Stripe account cannot authorize any certification write", async () => {
  let writes = 0;
  const stripe = { accounts: { retrieve: async () => ({ id: "acct_wrong" }) }, customers: { create: async () => { writes++; } } };
  await assert.rejects(certifyPinAIHybridSandbox(stripe as any, run, () => {}), /SANDBOX_ACCOUNT_MISMATCH/);
  assert.equal(writes, 0);
});
test("malformed run is rejected before creating a synthetic customer", async () => {
  let writes = 0;
  const stripe = { accounts: { retrieve: async () => ({ id: HYBRID_SANDBOX_PLATFORM }) }, customers: { create: async () => { writes++; } } };
  await assert.rejects(certifyPinAIHybridSandbox(stripe as any, "wrong", () => {})); assert.equal(writes, 0);
});
test("a persisted attempted run cannot create charges, invoices or another test host", async () => {
  let writes = 0;
  const stripe = { accounts: { retrieve: async () => ({ id: HYBRID_SANDBOX_PLATFORM }), create: async () => { writes++; } },
    customers: { create: async () => ({ id: "cus_guard", livemode: false }),
      retrieve: async () => ({ id: "cus_guard", metadata: { state: "ATTEMPTED" } }), update: async () => { writes++; } } };
  await assert.rejects(certifyPinAIHybridSandbox(stripe as any, run, () => {}), /ALREADY_ATTEMPTED/); assert.equal(writes, 0);
});
