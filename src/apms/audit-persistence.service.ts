import { PrismaClient } from "@prisma/client";
import type { AuditEntry } from "./audit-types";

const prisma = new PrismaClient();

function normalizeJsonValue(value: unknown) {
  if (value === undefined) return undefined;
  return value as any;
}

export async function persistAuditEntry(input: AuditEntry) {
  return prisma.apmsAuditEntry.upsert({
    where: {
      decisionId: input.decisionId,
    },
    create: {
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

      decisions: normalizeJsonValue(input.decisions),
      recommendedAction: input.recommendedAction ?? null,
      metadata: normalizeJsonValue(input.metadata),

      startedAt: input.startedAt ?? null,
      completedAt: input.completedAt ?? null,
      durationMs: input.durationMs ?? null,
    },
    update: {
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

      summary: input.summary ?? null,
      reason: input.reason ?? null,

      decisions: normalizeJsonValue(input.decisions),
      recommendedAction: input.recommendedAction ?? null,
      metadata: normalizeJsonValue(input.metadata),

      startedAt: input.startedAt ?? null,
      completedAt: input.completedAt ?? null,
      durationMs: input.durationMs ?? null,
    },
  });
}