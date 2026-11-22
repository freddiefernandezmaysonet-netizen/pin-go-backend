import assert from "node:assert/strict";
import test from "node:test";
import { guestPinAIInformationEnabled } from "./guest-information-availability.js";
import type { ActivationDb } from "./property-activation.js";

const scope = { organizationId: "org-a", propertyId: "property-a" };
const env = {
  PIN_AI_GUEST_GATEWAY_ENABLED: "true", PIN_AI_PROPERTY_ACTIVATION_ENABLED: "true",
  PIN_AI_CONNECT_DEBIT_ENABLED: "true", PIN_AI_CONNECT_DEBIT_ORGANIZATION_IDS: "org-a",
  PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "true",
};
const active = {
  pinAIEnabled: true, pinAITermsVersion: "pin-ai-connect-usd-1-reservation-v1",
  organization: { pinAIEnabled: true, pinAIRevision: 1, stripeConnectAccountId: "acct_synthetic" },
};

test("guidance requires active commercial Pin AI for the exact property and organization", async () => {
  let row: unknown = active;
  const db = { property: { findFirst: async ({ where }: { where: unknown }) => {
    assert.deepEqual(where, { id: scope.propertyId, organizationId: scope.organizationId, status: "ACTIVE" });
    return row;
  } } } as unknown as ActivationDb;
  assert.equal(await guestPinAIInformationEnabled(db, env, scope), true);
  for (row of [null, { ...active, pinAIEnabled: false },
    { ...active, organization: { ...active.organization, pinAIEnabled: false } },
    { ...active, organization: { ...active.organization, pinAIRevision: 0 } },
    { ...active, pinAITermsVersion: "outdated" }]) {
    assert.equal(await guestPinAIInformationEnabled(db, env, scope), false);
  }
  row = active;
  assert.equal(await guestPinAIInformationEnabled(db, { ...env, PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "false" }, scope), false);
});

test("disabled gateway, pilot, missing scope and lookup failures never advertise Pin AI", async () => {
  let reads = 0;
  const db = { property: { findFirst: async () => { reads++; throw new Error("offline"); } } } as unknown as ActivationDb;
  assert.equal(await guestPinAIInformationEnabled(db, {}, scope), false);
  assert.equal(await guestPinAIInformationEnabled(db, { ...env, PIN_AI_GUEST_GATEWAY_ENABLED: "false" }, scope), false);
  assert.equal(await guestPinAIInformationEnabled(db, { ...env, PIN_AI_PROPERTY_ACTIVATION_ENABLED: "false" }, scope), false);
  assert.equal(await guestPinAIInformationEnabled(db, env, { ...scope, propertyId: "" }), false);
  assert.equal(reads, 0);
  assert.equal(await guestPinAIInformationEnabled(db, env, scope), false);
  assert.equal(reads, 1);
});
