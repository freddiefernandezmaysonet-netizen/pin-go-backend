import test from "node:test";
import assert from "node:assert/strict";
import { cleaningPinAIRecoveryAllowed } from "./cleaning-pin-ai-activation.service.js";
import { PIN_AI_BILLING_TERMS } from "../pin-ai/billing-terms.js";
const now = new Date("2026-10-07T19:00:00Z");
const env = { PIN_AI_PROPERTY_ACTIVATION_ENABLED: "true", PIN_AI_ALL_ORGANIZATIONS_ENABLED: "true",
  PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "true", PIN_AI_CONNECT_DEBIT_ENABLED: "true" };
function fixture() {
  const property: any = { pinAIEnabled: true, pinAITermsVersion: PIN_AI_BILLING_TERMS.version,
    pinAITermsAcceptedAt: new Date(now.getTime() - 1000), pinAITermsAcceptedBy: "host", pinAIFeeExempt: true,
    organization: { pinAIEnabled: true, pinAIRevision: 1, stripeConnectAccountId: "acct_test" } };
  const queries: any[] = [];
  const db: any = { property: { findFirst: async (query: any) => { queries.push(query); return property; } } };
  return { property, db, queries };
}
test("consented fee-exempt property permits staff recovery without a guest conversation window", async () => {
  const f = fixture();
  assert.equal(await cleaningPinAIRecoveryAllowed(f.db, { propertyId: "p", organizationId: "org" }, now, env), true);
  for (const query of f.queries) assert.deepEqual(query.where, { id: "p", organizationId: "org", status: "ACTIVE" });
});
test("disabled, unconsented, future or outdated consent never authorizes recovery", async () => {
  const changes = [
    (p: any) => { p.pinAIEnabled = false; },
    (p: any) => { p.organization.pinAIEnabled = false; },
    (p: any) => { p.organization.pinAIRevision = 0; },
    (p: any) => { p.pinAITermsVersion = "old"; },
    (p: any) => { p.pinAITermsAcceptedAt = null; },
    (p: any) => { p.pinAITermsAcceptedAt = new Date(now.getTime() + 1); },
    (p: any) => { p.pinAITermsAcceptedBy = null; },
    (p: any) => { p.organization.stripeConnectAccountId = null; },
  ];
  for (const change of changes) { const f = fixture(); change(f.property);
    assert.equal(await cleaningPinAIRecoveryAllowed(f.db, { propertyId: "p", organizationId: "org" }, now, env), false); }
});
test("missing commercial controls and legacy pilot cannot grant cleaner hardware authority", async () => {
  for (const missing of Object.keys(env)) {
    const disabled: any = { ...env, [missing]: "false" };
    if (missing === "PIN_AI_ALL_ORGANIZATIONS_ENABLED") disabled.PIN_AI_CONNECT_DEBIT_ORGANIZATION_IDS = "";
    assert.equal(await cleaningPinAIRecoveryAllowed(fixture().db, { propertyId: "p", organizationId: "org" }, now, disabled), false);
  }
  assert.equal(await cleaningPinAIRecoveryAllowed(fixture().db, { propertyId: "p", organizationId: "org" }, now, {}), false);
});
