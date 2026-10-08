import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { AuditEntry } from "../apms/audit-types.js";
import { persistCleanerAccessEvidence } from "./cleaner-access-audit.service.js";
const url = process.env.CLEANER_ACCOUNT_TEST_DATABASE_URL;
if (url) { const u = new URL(url); if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.pathname !== "/cleaner_account_test") throw new Error("Isolated loopback database required"); }
test("PostgreSQL concurrent cleaner access checks preserve one immutable result per state", { skip: !url }, async t => {
  const db = new PrismaClient({ datasources: { db: { url: url! } } });
  const prefix = `synthetic-cleaner-audit-${randomUUID()}`;
  t.after(async () => { await db.apmsAuditEntry.deleteMany({ where: { decisionId: { startsWith: prefix } } }); await db.$disconnect(); });
  const entry: AuditEntry = { engine: "Access", decisionId: prefix, entityType: "ACCESS", entityId: prefix, eventType: "ACTION_COMPLETED", status: "SUCCESS", severity: "INFO", reason: "CLEANER_NFC_ACCESS_ALREADY_SCHEDULED", startedAt: new Date("2026-10-08T16:00Z"), completedAt: new Date("2026-10-08T16:00Z"), durationMs: 0, metadata: { confirmationId: prefix, staffMemberId: prefix } };
  const results = await Promise.all([0, 1, 2, 3].map(i => persistCleanerAccessEvidence(db, { ...entry, startedAt: new Date(entry.startedAt.getTime() + i * 1000), completedAt: new Date(entry.completedAt.getTime() + i * 1000) })));
  assert.equal(new Set(results.map(row => row.id)).size, 1);
  assert.equal(await db.apmsAuditEntry.count({ where: { decisionId: { startsWith: prefix } } }), 1);
  const saved = await db.apmsAuditEntry.findUniqueOrThrow({ where: { id: results[0].id } });
  await persistCleanerAccessEvidence(db, { ...entry, startedAt: new Date("2026-10-09T16:00Z") });
  assert.deepEqual(await db.apmsAuditEntry.findUniqueOrThrow({ where: { id: saved.id } }), saved);
  const active = await persistCleanerAccessEvidence(db, { ...entry, reason: "CLEANER_NFC_ACCESS_ALREADY_ACTIVE" });
  assert.notEqual(active.id, saved.id);
  assert.equal(await db.apmsAuditEntry.count({ where: { decisionId: { startsWith: prefix } } }), 2);
});
