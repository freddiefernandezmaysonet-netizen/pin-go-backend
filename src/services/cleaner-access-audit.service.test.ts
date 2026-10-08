import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import type { AuditEntry } from "../apms/audit-types.js";
import { persistCleanerAccessEvidence } from "./cleaner-access-audit.service.js";
const entry: AuditEntry = { engine: "Access", decisionId: "access-engine:property:reservation:cleaner-nfc-autopilot:CLEANER_CONFIRMATION", entityType: "ACCESS", entityId: "grant", eventType: "ACTION_COMPLETED", status: "SUCCESS", severity: "INFO", summary: "Cleaner access checked", reason: "CLEANER_NFC_ACCESS_ALREADY_SCHEDULED", startedAt: new Date("2026-10-08T16:00Z"), completedAt: new Date("2026-10-08T16:00Z"), durationMs: 0, metadata: { organizationId: "org", propertyId: "property", reservationId: "reservation", confirmationId: "offer", staffMemberId: "staff" } };
function fixture(race = false) {
  const rows = new Map<string, any>();
  let writes = 0;
  const db = { apmsAuditEntry: {
    findUnique: async ({ where }: any) => rows.get(where.decisionId) ?? null,
    create: async ({ data }: any) => {
      if (rows.has(data.decisionId)) throw Object.assign(new Error("unique"), { code: "P2002" });
      const saved = { ...data };
      if (race) { saved.startedAt = new Date("2026-10-08T15:59Z"); saved.completedAt = saved.startedAt; race = false; }
      rows.set(data.decisionId, saved); writes++;
      if (saved.startedAt !== data.startedAt) throw Object.assign(new Error("concurrent winner"), { code: "P2002" });
      return saved;
    },
  } } as unknown as Pick<PrismaClient, "apmsAuditEntry">;
  return { db, rows, get writes() { return writes; } };
}
test("reopening identical access preserves one immutable record and its original timestamps", async () => {
  const f = fixture();
  const first = await persistCleanerAccessEvidence(f.db, entry);
  const second = await persistCleanerAccessEvidence(f.db, { ...entry, startedAt: new Date("2026-10-08T17:00Z"), completedAt: new Date("2026-10-08T17:00Z") });
  assert.deepEqual(first, second); assert.equal(f.writes, 1);
  assert.equal(first.startedAt?.toISOString(), entry.startedAt.toISOString());
  assert.match(first.decisionId, /:v2:[a-f0-9]{64}$/);
});
test("state, cleaner and confirmation changes keep distinct evidence; legacy records stay untouched", async () => {
  const f = fixture(); f.rows.set(entry.decisionId, { legacy: true });
  const first = await persistCleanerAccessEvidence(f.db, entry);
  const active = await persistCleanerAccessEvidence(f.db, { ...entry, reason: "CLEANER_NFC_ACCESS_ALREADY_ACTIVE" });
  const backup = await persistCleanerAccessEvidence(f.db, { ...entry, metadata: { ...entry.metadata, confirmationId: "backup-offer", staffMemberId: "backup" } });
  assert.equal(new Set([first.decisionId, active.decisionId, backup.decisionId]).size, 3);
  assert.deepEqual(f.rows.get(entry.decisionId), { legacy: true }); assert.equal(f.writes, 3);
});
test("concurrent insertion replays the winner while a real evidence conflict remains an error", async () => {
  const f = fixture(true); const saved = await persistCleanerAccessEvidence(f.db, entry);
  assert.equal(saved.startedAt?.toISOString(), "2026-10-08T15:59:00.000Z"); assert.equal(f.writes, 1);
  f.rows.get(saved.decisionId).summary = "different immutable evidence";
  await assert.rejects(persistCleanerAccessEvidence(f.db, entry), /APMS_AUDIT_DECISION_ID_CONFLICT/);
  assert.equal(f.writes, 1);
});
test("concurrent identical checks share a single record", async () => {
  const f = fixture(); const result = await Promise.all([persistCleanerAccessEvidence(f.db, entry), persistCleanerAccessEvidence(f.db, { ...entry, startedAt: new Date("2026-10-08T17:00Z") })]);
  assert.deepEqual(result[0], result[1]); assert.equal(f.writes, 1);
});
