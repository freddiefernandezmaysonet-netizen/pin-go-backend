import assert from "node:assert/strict";
import test from "node:test";
import { commercialPinAIEnabled, commercialIncidentHistoryAllowed, type ActivationDb } from "./property-activation.js";

const scope = { organizationId: "org-a", propertyId: "property-a" };
const env = { PIN_AI_PROPERTY_ACTIVATION_ENABLED: "true", PIN_AI_CONNECT_DEBIT_ENABLED: "true", PIN_AI_CONNECT_DEBIT_ORGANIZATION_IDS: "org-a", PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "true" };
test("unreleased controls preserve the existing pilot without reading new schema", async () => {
  const db = { property: { findFirst: async () => { throw new Error("unexpected read"); } } } as unknown as ActivationDb;
  assert.equal(await commercialPinAIEnabled(db, {}, scope), null);
  assert.equal(await commercialIncidentHistoryAllowed(db, {}, scope), false);
});
test("scoped commercial decisions cannot be widened by reservation canaries", async () => {
  let row: unknown;
  const db = { property: { findFirst: async ({ where }: { where: unknown }) => {
    assert.deepEqual(where, { id: scope.propertyId, organizationId: scope.organizationId, status: "ACTIVE" });
    return row;
  } } } as unknown as ActivationDb;
  for (const [revision, orgEnabled, propertyEnabled, expected] of [
    [0, false, false, null], [1, true, true, true], [1, true, false, false], [2, false, true, false],
  ] as const) {
    row = { pinAITermsVersion: "pin-ai-connect-usd-1-reservation-v1", pinAIEnabled: propertyEnabled, organization: { stripeConnectAccountId: "acct_synthetic", pinAIEnabled: orgEnabled, pinAIRevision: revision } };
    assert.equal(await commercialPinAIEnabled(db, { ...env, PIN_AI_ACTION_CANARY_RESERVATION_IDS: "any-reservation" }, scope), expected);
  }
  row = null;
  assert.equal(await commercialPinAIEnabled(db, env, scope), false);
});
test("past incident access stays tenant-bound and does not depend on new-assistance switches", async () => {
  const exactDb = { property: { findFirst: async ({ where }: { where: unknown }) => {
    assert.deepEqual(where, { id: scope.propertyId, organizationId: scope.organizationId,
      pinAIRevision: { gt: 0 }, organization: { pinAIRevision: { gt: 0 } } });
    return { id: scope.propertyId };
  } } } as unknown as ActivationDb;
  assert.equal(await commercialIncidentHistoryAllowed(exactDb, env, scope), true);
});
test("global availability never falls back to pilot before host activation", async () => {
  const db = { property: { findFirst: async () => ({ pinAIEnabled: false, pinAITermsVersion: null,
    organization: { pinAIEnabled: false, pinAIRevision: 0, stripeConnectAccountId: "acct_synthetic" } }) } } as unknown as ActivationDb;
  assert.equal(await commercialPinAIEnabled(db, { ...env, PIN_AI_ALL_ORGANIZATIONS_ENABLED: "true" }, scope), false);
  assert.equal(await commercialPinAIEnabled(db, env, scope), null);
});
