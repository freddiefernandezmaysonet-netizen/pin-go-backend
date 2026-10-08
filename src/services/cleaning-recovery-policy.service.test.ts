import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { DEFAULT_CLEANING_RECOVERY_POLICY, parseCleaningRecoveryPolicy, readCleaningRecoveryPolicy, saveCleaningRecoveryPolicy } from "./cleaning-recovery-policy.service.js";
import { buildCleaningRecoveryPolicyRouter } from "../routes/cleaning-recovery-policy.routes.js";
const scope = { propertyId: "property", organizationId: "org", userId: "host" };
function fixture() {
  let stored: any = null; let locked = false;
  const tx: any = {
    $queryRaw: async () => { locked = true; },
    property: { findFirst: async ({ where }: any) => where.id === "property" && where.organizationId === "org" ? { id: "property" } : null },
    cleaningRecoveryPolicy: {
      findUnique: async () => stored,
      upsert: async ({ create, update }: any) => { assert.equal(locked, true); stored = stored ? { ...stored, ...update } : create; return stored; },
    },
  };
  return { db: { ...tx, $transaction: async (fn: any) => fn(tx) } as any, get stored() { return stored; } };
}
test("all properties have defaults without enabling access extensions or modifying property/work", async () => {
  const f = fixture();
  assert.deepEqual(await readCleaningRecoveryPolicy(f.db, scope), DEFAULT_CLEANING_RECOVERY_POLICY);
  assert.equal(f.stored, null); assert.equal(DEFAULT_CLEANING_RECOVERY_POLICY.maxAccessExtensionMinutes, 0);
});
test("save increments revisions and rejects stale writers", async () => {
  const f = fixture();
  const saved = await saveCleaningRecoveryPolicy(f.db, scope, { ...DEFAULT_CLEANING_RECOVERY_POLICY, maxAccessExtensionMinutes: 60 });
  assert.equal(saved.revision, 1); assert.equal(saved.updatedByUserId, "host");
  await assert.rejects(saveCleaningRecoveryPolicy(f.db, scope, DEFAULT_CLEANING_RECOVERY_POLICY), /POLICY_CONFLICT/);
  const changed = await saveCleaningRecoveryPolicy(f.db, scope, { ...saved, maxDelayMinutes: 45 });
  assert.equal(changed.revision, 2); assert.equal(changed.maxAccessExtensionMinutes, 60);
});
test("read and write reject a foreign organization/property", async () => {
  const f = fixture();
  await assert.rejects(readCleaningRecoveryPolicy(f.db, { ...scope, organizationId: "foreign" }), /PROPERTY_NOT_FOUND/);
  await assert.rejects(saveCleaningRecoveryPolicy(f.db, { ...scope, propertyId: "foreign" }, DEFAULT_CLEANING_RECOVERY_POLICY), /PROPERTY_NOT_FOUND/);
  assert.equal(f.stored, null);
});
test("limits reject coercion, negative, fractional, missing and excessive values", () => {
  for (const value of [-1, 241, 1.5, "30", null, undefined]) {
    assert.throws(() => parseCleaningRecoveryPolicy({ ...DEFAULT_CLEANING_RECOVERY_POLICY, maxDelayMinutes: value }), /POLICY_INVALID/);
  }
  assert.throws(() => parseCleaningRecoveryPolicy({ ...DEFAULT_CLEANING_RECOVERY_POLICY, arrivalSafetyMarginMinutes: 121 }), /POLICY_INVALID/);
  assert.throws(() => parseCleaningRecoveryPolicy({ ...DEFAULT_CLEANING_RECOVERY_POLICY, revision: -1 }), /POLICY_INVALID/);
});
test("HTTP settings use authenticated host scope, reject cleaner and return revision conflict", async () => {
  const f = fixture(); let role = "ORG_ADMIN";
  const app = express(); app.use(express.json());
  app.use(buildCleaningRecoveryPolicyRouter(f.db, (req: any, _res, next) => { req.user = { id: "host", orgId: "org", role }; next(); }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/properties/property/cleaning-recovery-policy`;
  const write = () => fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...DEFAULT_CLEANING_RECOVERY_POLICY, organizationId: "foreign", userId: "foreign" }) });
  try {
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await write()).status, 200); assert.equal(f.stored.updatedByUserId, "host");
    assert.equal((await write()).status, 409);
    role = "CLEANER";
    assert.equal((await fetch(url)).status, 403); assert.equal((await write()).status, 403);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
