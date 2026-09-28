import type { PrismaClient } from "@prisma/client";
import { upsertOperationalIssue } from "../apms/operational-intelligence.service.js";

export async function persistCleaningHostAttention(input: Readonly<{
  prisma: PrismaClient;
  cleaningWorkId: string;
  occurredAt: Date;
}>) {
  const work = await input.prisma.cleaningWork.findUnique({
    where: { id: input.cleaningWorkId },
    select: {
      id: true, reservationId: true, propertyId: true, staffMemberId: true,
      cancelledAt: true, supersededAt: true, completionConfirmedAt: true,
    },
  });
  if (!work || work.cancelledAt || work.supersededAt || work.completionConfirmedAt) return null;
  const [reservation, staff, property] = await Promise.all([
    input.prisma.reservation.findUnique({ where: { id: work.reservationId }, select: { reservationNumber: true } }),
    input.prisma.staffMember.findUnique({ where: { id: work.staffMemberId }, select: { fullName: true } }),
    input.prisma.property.findUnique({ where: { id: work.propertyId }, select: { name: true, organizationId: true } }),
  ]);
  if (!property) return null;
  const cleanerName = staff?.fullName?.trim() || "Cleaner";
  return upsertOperationalIssue(input.prisma, {
    operationalKey: `CLEANING_FOLLOWUP:${work.id}`,
    issueCode: "CLEANING_COMPLETION_CONFIRMATION_PENDING",
    title: "Cleaning confirmation needs attention",
    issue: `${cleanerName} has not confirmed cleaning completion within the agreed follow-up window for ${property.name}.`,
    operationalImpact: "Pin&Go does not yet have a cleaner completion declaration for this cleaning work.",
    recommendedAction: "Review the cleaning work status and contact the cleaner if confirmation is still required.",
    nextAutomaticStep: null,
    engine: "CLEANING",
    severity: "WARNING",
    workflowState: "ACTION_REQUIRED",
    visibility: "HOST",
    responsibleActor: "HOST",
    actionRequired: true,
    canAutoResolve: true,
    autoResolveStatus: "AVAILABLE",
    autoResolveActionCode: "RECHECK_CLEANING_FOLLOWUP",
    organizationId: property.organizationId,
    propertyId: work.propertyId,
    reservationId: work.reservationId,
    reservationNumber: reservation?.reservationNumber ?? null,
    staffMemberId: work.staffMemberId,
    cleanerName,
    sourceType: "WORKER",
    actionTarget: "CLEANING",
    metadata: {
      cleaningWorkId: work.id,
      evidenceMeaning: "CLEANER_COMPLETION_CONFIRMATION_MISSING",
      physicalCompletionVerified: false,
    },
    transitionCode: "CLEANING_FOLLOWUP_HOST_ATTENTION_REQUIRED",
    transitionSummary: "The cleaner completion confirmation remained missing after the configured follow-up window.",
    transitionedBy: "PIN_GO",
    occurredAt: input.occurredAt,
    lastSignalAt: input.occurredAt,
  });
}

export async function resolveCleaningHostAttention(input: Readonly<{
  prisma: PrismaClient;
  cleaningWorkId: string;
  occurredAt: Date;
}>) {
  const key = `CLEANING_FOLLOWUP:${input.cleaningWorkId}`;
  const existing = await input.prisma.operationalIssue.findUnique({
    where: { operationalKey: key },
    select: { workflowState: true },
  });
  if (!existing || existing.workflowState === "RESOLVED") return null;
  const work = await input.prisma.cleaningWork.findUnique({
    where: { id: input.cleaningWorkId },
    select: { reservationId: true, propertyId: true, staffMemberId: true, completionConfirmedAt: true },
  });
  if (!work?.completionConfirmedAt) return null;
  const [reservation, staff, property] = await Promise.all([
    input.prisma.reservation.findUnique({ where: { id: work.reservationId }, select: { reservationNumber: true } }),
    input.prisma.staffMember.findUnique({ where: { id: work.staffMemberId }, select: { fullName: true } }),
    input.prisma.property.findUnique({ where: { id: work.propertyId }, select: { name: true, organizationId: true } }),
  ]);
  if (!property) return null;
  const cleanerName = staff?.fullName?.trim() || "Cleaner";
  return upsertOperationalIssue(input.prisma, {
    operationalKey: key,
    issueCode: "CLEANING_COMPLETION_CONFIRMED",
    title: "Cleaning completion confirmed",
    issue: `${cleanerName} confirmed cleaning completion for ${property.name}.`,
    operationalImpact: null,
    recommendedAction: null,
    nextAutomaticStep: null,
    engine: "CLEANING",
    severity: "INFO",
    workflowState: "RESOLVED",
    visibility: "SYSTEM",
    responsibleActor: "PIN_GO",
    actionRequired: false,
    canAutoResolve: true,
    autoResolveStatus: "SUCCEEDED",
    autoResolveActionCode: "RECHECK_CLEANING_FOLLOWUP",
    organizationId: property.organizationId,
    propertyId: work.propertyId,
    reservationId: work.reservationId,
    reservationNumber: reservation?.reservationNumber ?? null,
    staffMemberId: work.staffMemberId,
    cleanerName,
    sourceType: "WORKER",
    actionTarget: "CLEANING",
    resolutionCode: "CLEANER_COMPLETION_DECLARATION_RECEIVED",
    resolutionSummary: "The cleaner submitted the missing completion declaration.",
    resolutionType: "AUTOMATIC",
    resolvedBy: "CLEANER",
    resolvedAt: input.occurredAt,
    metadata: { cleaningWorkId: input.cleaningWorkId, physicalCompletionVerified: false },
    transitionCode: "CLEANING_FOLLOWUP_AUTO_RESOLVED",
    transitionSummary: "The host-attention workflow auto-resolved after the cleaner confirmed completion.",
    transitionedBy: "CLEANER",
    occurredAt: input.occurredAt,
    lastSignalAt: input.occurredAt,
  });
}
