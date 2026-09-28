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
