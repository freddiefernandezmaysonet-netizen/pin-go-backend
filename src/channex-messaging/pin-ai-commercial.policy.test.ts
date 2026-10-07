import assert from "node:assert/strict";
import test from "node:test";
import { channelPropertyEnabled, channelActivationSince, channelBookingAvailable } from "./pin-ai-commercial.policy.js";
import { autoConfig } from "./pin-ai-auto.policy.js";
import { PIN_AI_BILLING_TERMS } from "../pin-ai/billing-terms.js";

const env = { PIN_AI_ALL_ORGANIZATIONS_ENABLED: "true", PIN_AI_PROPERTY_ACTIVATION_ENABLED: "true",
  PIN_AI_CONNECT_DEBIT_ENABLED: "true", PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "true",
  PIN_AI_CHANNEX_AUTO_ENABLED: "true", PIN_AI_CHANNEX_AUTO_START_AT: "2026-01-01T00:00:00Z" };
const scope = { organizationId: "new-org", propertyId: "new-property" };
const acceptedAt = new Date("2026-01-02T00:00:00Z"), activatedAt = new Date("2026-01-03T00:00:00Z");
function harness() {
  const property = { pinAIEnabled: true, pinAIRevision: 2, pinAITermsVersion: PIN_AI_BILLING_TERMS.version as string,
    pinAITermsAcceptedAt: acceptedAt, pinAITermsAcceptedBy: "host",
    organization: { pinAIEnabled: true, pinAIRevision: 1, stripeConnectAccountId: "acct_host" } };
  const event = { ...scope, status: "APPLIED", createdAt: activatedAt, metadata: { enabled: true } };
  const queries: any[] = [];
  const db: any = { property: { findFirst: async (q: unknown) => { queries.push(q); return property; } },
    apmsAuditEntry: { findUnique: async (q: unknown) => { queries.push(q); return event; } } };
  return { db, property, event, queries };
}
test("global channel scope has no pilot IDs but still requires current property activation", async () => {
  const h = harness();
  assert.equal(autoConfig(env).enabled, true);
  assert.equal(await channelPropertyEnabled(h.db, env, scope), true);
  h.property.pinAIEnabled = false;
  assert.equal(await channelPropertyEnabled(h.db, env, scope), false);
  h.property.pinAIEnabled = true; h.property.organization.pinAIEnabled = false;
  assert.equal(await channelPropertyEnabled(h.db, env, scope), false);
  h.property.organization.pinAIEnabled = true; h.property.pinAITermsVersion = "obsolete";
  assert.equal(await channelPropertyEnabled(h.db, env, scope), false);
});
test("unactivated organization, missing Connect or recording gate cannot use the pilot as fallback", async () => {
  const h = harness(); h.property.organization.pinAIRevision = 0;
  assert.equal(await channelPropertyEnabled(h.db, env, scope), false);
  h.property.organization.pinAIRevision = 1; h.property.organization.stripeConnectAccountId = "";
  assert.equal(await channelPropertyEnabled(h.db, env, scope), false);
  h.property.organization.stripeConnectAccountId = "acct_host";
  assert.equal(await channelPropertyEnabled(h.db, { ...env, PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "false" }, scope), false);
  assert.equal(await channelPropertyEnabled(h.db, { ...env, PIN_AI_CHANNEX_AUTO_ENABLED: "false" }, scope), false);
  h.property.pinAITermsAcceptedBy = "";
  assert.equal(await channelPropertyEnabled(h.db, env, scope), false);
});
test("reactivation boundary uses current audited revision, never historical consent alone", async () => {
  const h = harness();
  assert.equal(+(await channelActivationSince(h.db, env, scope))!, +activatedAt);
  assert.deepEqual(h.queries.at(-1).where, { decisionId: "pin-ai-activation:property:new-property:2" });
  h.event.metadata.enabled = false;
  assert.equal(await channelActivationSince(h.db, env, scope), null);
  h.event.metadata.enabled = true; h.event.organizationId = "other-org";
  assert.equal(await channelActivationSince(h.db, env, scope), null);
});
test("unchanged pilot keeps its exact IDs and explicit UTC activation boundary without commercial reads", async () => {
  const pilot = { PIN_AI_CHANNEX_AUTO_ENABLED: "true", PIN_AI_CHANNEX_AUTO_START_AT: env.PIN_AI_CHANNEX_AUTO_START_AT,
    PIN_AI_CHANNEX_AUTO_ORGANIZATION_IDS: scope.organizationId, PIN_AI_CHANNEX_AUTO_PROPERTY_IDS: scope.propertyId };
  const db: any = { property: { findFirst: () => { throw new Error("pilot must not read commercial tables"); } } };
  assert.equal(await channelPropertyEnabled(db, pilot, scope), true);
  assert.equal(await channelPropertyEnabled(db, pilot, { ...scope, propertyId: "other" }), false);
  assert.equal(+(await channelActivationSince(db, pilot, scope))!, +new Date(env.PIN_AI_CHANNEX_AUTO_START_AT));
  assert.equal(autoConfig({ ...env, PIN_AI_CHANNEX_AUTO_START_AT: "" }).enabled, false);
});
test("OTA booking uses canonical 24-hour window, unique tenant link and active reservation", async () => {
  const checkIn = new Date("2026-01-05T20:00:00Z"), checkOut = new Date("2026-01-07T15:00:00Z");
  let rows = [{ status: "ACTIVE", checkIn, checkOut }]; const queries: any[] = [];
  const db: any = { reservation: { findMany: async (q: unknown) => { queries.push(q); return rows; } } };
  assert.equal(await channelBookingAvailable(db, env, scope, "booking", new Date(+checkIn - 86400000 - 1)), false);
  assert.equal(await channelBookingAvailable(db, env, scope, "booking", new Date(+checkIn - 86400000)), true);
  assert.equal(await channelBookingAvailable(db, env, scope, "booking", new Date(+checkOut + 86400000)), false);
  assert.equal(queries[0].where.property.organizationId, scope.organizationId);
  rows[0]!.status = "CANCELLED";
  assert.equal(await channelBookingAvailable(db, env, scope, "booking", checkIn), false);
  rows = [];
  assert.equal(await channelBookingAvailable(db, env, scope, "booking", checkIn), false);
  assert.equal(await channelBookingAvailable(db, env, scope, null, checkIn), true);
});
