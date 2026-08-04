import type { Prisma, PrismaClient } from "@prisma/client";
import type { AuditEntry } from "./audit-types.js";

type AuditPersistenceClient = Pick<PrismaClient, "apmsAuditEntry">;

export const APMS_AUDIT_DECISION_ID_CONFLICT =
  "APMS_AUDIT_DECISION_ID_CONFLICT";

export class ApmsAuditDecisionIdConflictError extends Error {
  readonly code = APMS_AUDIT_DECISION_ID_CONFLICT;

  constructor(readonly decisionId: string) {
    super(
      `${APMS_AUDIT_DECISION_ID_CONFLICT}: immutable audit evidence already exists for decisionId ${decisionId}`
    );
    this.name = "ApmsAuditDecisionIdConflictError";
  }
}

function normalizeJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function buildCreateData(
  input: AuditEntry
): Prisma.ApmsAuditEntryCreateInput {
  return {
    organizationId:
      typeof input.metadata?.organizationId === "string"
        ? input.metadata.organizationId
        : null,
    propertyId:
      typeof input.metadata?.propertyId === "string"
        ? input.metadata.propertyId
        : null,
    reservationId:
      typeof input.metadata?.reservationId === "string"
        ? input.metadata.reservationId
        : null,
    entityType: input.entityType ?? "SYSTEM",
    entityId: input.entityId ?? input.decisionId,
    engine: input.engine,
    eventType: input.eventType ?? null,
    status: input.status,
    severity: input.severity ?? null,
    decisionId: input.decisionId,
    summary: input.summary ?? null,
    reason: input.reason ?? null,
    ...(input.decisions !== undefined
      ? { decisions: normalizeJsonValue(input.decisions) }
      : {}),
    recommendedAction: input.recommendedAction ?? null,
    ...(input.metadata !== undefined
      ? { metadata: normalizeJsonValue(input.metadata) }
      : {}),
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
    durationMs: input.durationMs ?? null,
  };
}

function normalizeComparable(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeComparable);

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalizeComparable(record[key])])
    );
  }

  return value;
}

function evidenceMatches(
  existing: NonNullable<
    Awaited<
      ReturnType<
        AuditPersistenceClient["apmsAuditEntry"]["findUnique"]
      >
    >
  >,
  expected: Prisma.ApmsAuditEntryCreateInput
): boolean {
  const existingEvidence = {
    organizationId: existing.organizationId,
    propertyId: existing.propertyId,
    reservationId: existing.reservationId,
    entityType: existing.entityType,
    entityId: existing.entityId,
    engine: existing.engine,
    eventType: existing.eventType,
    status: existing.status,
    severity: existing.severity,
    decisionId: existing.decisionId,
    summary: existing.summary,
    reason: existing.reason,
    decisions: existing.decisions,
    recommendedAction: existing.recommendedAction,
    metadata: existing.metadata,
    startedAt: existing.startedAt,
    completedAt: existing.completedAt,
    durationMs: existing.durationMs,
  };

  const expectedEvidence = {
    organizationId: expected.organizationId ?? null,
    propertyId: expected.propertyId ?? null,
    reservationId: expected.reservationId ?? null,
    entityType: expected.entityType,
    entityId: expected.entityId,
    engine: expected.engine,
    eventType: expected.eventType ?? null,
    status: expected.status,
    severity: expected.severity ?? null,
    decisionId: expected.decisionId,
    summary: expected.summary ?? null,
    reason: expected.reason ?? null,
    decisions: expected.decisions ?? null,
    recommendedAction: expected.recommendedAction ?? null,
    metadata: expected.metadata ?? null,
    startedAt: expected.startedAt ?? null,
    completedAt: expected.completedAt ?? null,
    durationMs: expected.durationMs ?? null,
  };

  return (
    JSON.stringify(normalizeComparable(existingEvidence)) ===
    JSON.stringify(normalizeComparable(expectedEvidence))
  );
}

export async function persistAuditEntry(
  prisma: AuditPersistenceClient,
  input: AuditEntry
) {
  const createData = buildCreateData(input);
  const existing = await prisma.apmsAuditEntry.findUnique({
    where: { decisionId: input.decisionId },
  });

  if (existing) {
    if (evidenceMatches(existing, createData)) return existing;
    throw new ApmsAuditDecisionIdConflictError(input.decisionId);
  }

  return prisma.apmsAuditEntry.create({
    data: createData,
  });
}
