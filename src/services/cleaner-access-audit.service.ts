import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { AuditEntry } from "../apms/audit-types.js";
import { ApmsAuditDecisionIdConflictError, persistAuditEntry } from "../apms/audit-persistence.service.js";

function canonical(value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** Reuse identical cleaner access evidence; preserve separate state changes and immutable history. */
export async function persistCleanerAccessEvidence(db: Pick<PrismaClient, "apmsAuditEntry">, input: AuditEntry) {
  const { startedAt: _start, completedAt: _end, durationMs: _duration, decisionId, ...evidence } = input;
  const digest = createHash("sha256").update(JSON.stringify(canonical(evidence))).digest("hex");
  const entry = { ...input, decisionId: `${decisionId}:v2:${digest}` };
  async function persist() {
    const existing = await db.apmsAuditEntry.findUnique({ where: { decisionId: entry.decisionId } });
    // Only replay timestamps. persistAuditEntry still checks every other immutable field.
    return persistAuditEntry(db, existing ? {
      ...entry, startedAt: existing.startedAt ?? entry.startedAt,
      completedAt: existing.completedAt ?? entry.completedAt, durationMs: existing.durationMs ?? entry.durationMs,
    } : entry);
  }
  try { return await persist(); }
  catch (error) {
    const uniqueRace = error && typeof error === "object" && "code" in error && error.code === "P2002";
    if (!uniqueRace && !(error instanceof ApmsAuditDecisionIdConflictError)) throw error;
    // A concurrent check can win between the read and create; validate its evidence on replay.
    return persist();
  }
}
