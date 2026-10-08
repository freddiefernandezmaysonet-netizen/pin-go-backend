import type { Prisma, PrismaClient } from "@prisma/client";
import { reopenOperationalIssue, upsertOperationalIssue, type UpsertOperationalIssueInput } from "../apms/operational-intelligence.service.js";

type Turnover = {
  reservationId: string;
  propertyId: string;
  organizationId: string;
  propertyName: string;
  reservationNumber: string | null;
};

/** Older reservation-audit snapshots must not replace a committed withdrawal outcome. */
export async function persistCleaningAuditAttention(db: PrismaClient, items: UpsertOperationalIssueInput[]) {
  await db.$transaction(async tx => {
    for (const item of items) {
      if (item.operationalKey.startsWith("CLEANING_CONFIRMATION:")) {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", item.operationalKey);
        const existing = await tx.operationalIssue.findUnique({
          where: { operationalKey: item.operationalKey }, select: { issueCode: true },
        });
        if (existing && ["CLEANING_BACKUPS_EXHAUSTED", "CLEANING_OFFER_SUPERSEDED"].includes(existing.issueCode)) continue;
      }
      await upsertOperationalIssue(tx, item);
    }
  });
}

/** Reuses the canonical offer key so the reservation audit cannot create a second host issue. */
export async function recordCleaningBackupExhaustion(
  tx: Prisma.TransactionClient,
  input: Turnover & { confirmationId: string; occurredAt: Date },
) {
  const operationalKey = `CLEANING_CONFIRMATION:${input.confirmationId}`;
  const recommendedAction = "Arrange a viable cleaner and obtain explicit acceptance. Review the next arrival before changing the schedule.";
  await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", operationalKey);
  const previous = await tx.operationalIssue.findUnique({ where: { operationalKey }, select: { workflowState: true } });
  // Availability may already have resolved this offer's canonical workflow before cancellation.
  if (previous?.workflowState === "RESOLVED") {
    await reopenOperationalIssue(tx, {
      operationalKey, workflowState: "ACTION_REQUIRED", severity: "WARNING", responsibleActor: "HOST",
      actionRequired: true, recommendedAction, nextAutomaticStep: null,
      canAutoResolve: false, autoResolveStatus: "NOT_SUPPORTED",
      reopenCode: "CLEANING_COVERAGE_LOST", reopenSummary: "A previously resolved offer was withdrawn and no viable backup remains.",
      reopenedBy: "PIN_GO", sourceType: "ENGINE_EVENT", occurredAt: input.occurredAt,
    });
  }
  return upsertOperationalIssue(tx, {
    operationalKey,
    issueCode: "CLEANING_BACKUPS_EXHAUSTED",
    title: "No viable cleaner available",
    issue: `No untried configured cleaner can accept this turnover for ${input.propertyName} within the current schedule.`,
    operationalImpact: "This turnover has no current cleaning offer or confirmed cleaner. Cleaning completion and property readiness are not established.",
    recommendedAction,
    nextAutomaticStep: null,
    engine: "Cleaning",
    severity: "WARNING",
    workflowState: "ACTION_REQUIRED",
    visibility: "HOST",
    responsibleActor: "HOST",
    actionRequired: true,
    canAutoResolve: false,
    autoResolveStatus: "NOT_SUPPORTED",
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    reservationId: input.reservationId,
    reservationNumber: input.reservationNumber,
    sourceType: "ENGINE_EVENT",
    actionTarget: "CLEANING",
    metadata: { confirmationId: input.confirmationId, recovery: "NO_VIABLE_BACKUP",
      physicalCompletionVerified: false, accessChanged: false, automaticRecoveryImplemented: false },
    transitionCode: "CLEANING_BACKUPS_EXHAUSTED",
    transitionSummary: "The withdrawal was recorded and no remaining configured cleaner met the schedule constraints.",
    transitionedBy: "PIN_GO",
    occurredAt: input.occurredAt,
    lastSignalAt: input.occurredAt,
  });
}

/** Close superseded offer attention only; cleaner access incidents remain independent. */
export async function resolveWithdrawnCleaningOfferAttention(
  tx: Prisma.TransactionClient,
  input: Turnover & { replacementAccepted: boolean; occurredAt: Date },
) {
  const withdrawn = await tx.cleaningConfirmation.findMany({
    where: { reservationId: input.reservationId, propertyId: input.propertyId,
      status: { in: ["CANCELLED", "DECLINED", "EXPIRED"] } }, select: { id: true },
  });
  if (!withdrawn.length) return;
  const issues = await tx.operationalIssue.findMany({
    where: { organizationId: input.organizationId, propertyId: input.propertyId,
      reservationId: input.reservationId,
      operationalKey: { in: withdrawn.map(offer => `CLEANING_CONFIRMATION:${offer.id}`) },
      workflowState: { not: "RESOLVED" },
      issueCode: { in: ["CLEANING_CONFIRMATION_PENDING", "CLEANING_CONFIRMATION_DECLINED", "CLEANING_BACKUPS_EXHAUSTED"] } },
    select: { operationalKey: true },
  });
  for (const issue of issues) {
    await upsertOperationalIssue(tx, {
      operationalKey: issue.operationalKey,
      issueCode: "CLEANING_OFFER_SUPERSEDED",
      title: input.replacementAccepted ? "Cleaner coverage restored" : "Replacement cleaner offer pending",
      issue: input.replacementAccepted ? "A replacement cleaner explicitly accepted the turnover."
        : "Pin&Go offered the turnover to the next viable configured cleaner; acceptance remains pending.",
      engine: "Cleaning", severity: "INFO", workflowState: "RESOLVED", visibility: "SYSTEM",
      responsibleActor: "PIN_GO", actionRequired: false, canAutoResolve: true, autoResolveStatus: "SUCCEEDED",
      organizationId: input.organizationId, propertyId: input.propertyId, reservationId: input.reservationId,
      reservationNumber: input.reservationNumber, sourceType: "ENGINE_EVENT", actionTarget: "CLEANING",
      resolutionCode: input.replacementAccepted ? "REPLACEMENT_CLEANER_ACCEPTED" : "REPLACEMENT_OFFER_CREATED",
      resolutionSummary: "The withdrawn offer no longer requires separate attention; the current offer owns coverage tracking.",
      resolutionType: "SUPERSEDED", resolvedBy: "PIN_GO", resolvedAt: input.occurredAt,
      metadata: { replacementAccepted: input.replacementAccepted, completionDeclared: false, accessChanged: false },
      transitionCode: "CLEANING_WITHDRAWN_OFFER_SUPERSEDED",
      transitionSummary: "Attention on the old withdrawn offer was closed after replacement progressed.",
      transitionedBy: "PIN_GO", occurredAt: input.occurredAt, lastSignalAt: input.occurredAt,
    });
  }
}
