import type { PrismaClient } from "@prisma/client";
import { assessLatestCleaningIssue } from "./cleaning-issue-assessment.service.js";
import { extendCleanerAccess } from "./cleaner-access-extension.service.js";
import { offerBackupForIncompleteCleaning } from "./cleaning-reassignment.service.js";
import { upsertOperationalIssue } from "../apms/operational-intelligence.service.js";
import { queueCleaningHostAttentionNotice } from "./cleaning-followup-host-notice.service.js";

import { cleaningPinAIRecoveryAllowed } from "./cleaning-pin-ai-activation.service.js";

const defaults = { extend: extendCleanerAccess, backup: offerBackupForIncompleteCleaning,
  assess: assessLatestCleaningIssue, allowed: cleaningPinAIRecoveryAllowed, persist: upsertOperationalIssue, notify: queueCleaningHostAttentionNotice };
/** Internal deterministic Pin AI recovery. The guest-facing read tool never
 * executes this function or receives report text, card IDs or offer tokens. */
export async function recoverCleaningIssue(db: PrismaClient, workId: string, now = new Date(), dependencies = defaults) {
  const work = await db.cleaningWork.findUnique({ where: { id: workId } });
  if (!work) return { state: "NO_WORK" };
  const report = await db.cleaningWorkIssueReport.findFirst({ where: { cleaningWorkId: work.id }, orderBy: [{ reportedAt: "desc" }, { id: "desc" }] });
  if (!report) return { state: "NO_REPORT" };
  const reservation = await db.reservation.findFirst({ where: { id: work.reservationId, propertyId: work.propertyId }, include: { property: true } });
  if (!reservation) return { state: "NO_CONTEXT" };
  let state = "FOLLOW_ESTIMATE";
  let reason = "WITHIN_EXISTING_WINDOW";
  let accessChanged = false;
  let needsHost = false;
  let resolved = false;
  if (work.cancelledAt || work.completionConfirmedAt || reservation.status !== "ACTIVE" || reservation.property.status !== "ACTIVE") {
    state = "REPORT_SUPERSEDED"; reason = "WORK_CLOSED"; resolved = true;
  } else if (work.supersededAt) {
    const offer = await db.cleaningConfirmation.findFirst({ where: { reservationId: work.reservationId, status: { in: ["PENDING", "CONFIRMED"] } } });
    if (offer?.status === "CONFIRMED") { state = "BACKUP_ACCEPTED"; reason = "EXPLICIT_ACCEPTANCE_RECORDED"; resolved = true; }
    else if (offer) {
      state = "BACKUP_OFFER_PENDING"; reason = "EXPLICIT_ACCEPTANCE_REQUIRED";
      // The existing availability dispatcher owns quiet-hours urgency for all
      // offers, including cancellation backups. Do not duplicate its host issue.
    } else { state = "HOST_REVIEW_REQUIRED"; reason = "NO_VIABLE_BACKUP"; needsHost = true; }
  } else if (!await dependencies.allowed(db, { propertyId: work.propertyId, organizationId: reservation.property.organizationId }, now)) {
    state = "HOST_REVIEW_REQUIRED"; reason = "PIN_AI_NOT_ACTIVE_OR_CONSENTED"; needsHost = true;
  } else {
    const assessment = await db.$transaction(tx => dependencies.assess(tx, work, now));
    if (!assessment) return { state: "NO_REPORT" };
    state = assessment.decision; reason = assessment.reason;
    if (state === "ACCESS_EXTENDED") { resolved = true; accessChanged = true; }
    try {
      if (state === "ACCESS_EXTENSION_REQUIRED" || state === "ACCESS_EXTENSION_PENDING") {
        const result = await dependencies.extend(db, { reportId: report.id, organizationId: reservation.property.organizationId });
        state = result.state === "APPLIED" ? "ACCESS_EXTENDED" : result.state === "SENDING" || result.state === "PREPARED" ? "ACCESS_EXTENSION_PENDING" : "HOST_REVIEW_REQUIRED";
        accessChanged = result.state === "APPLIED"; resolved = accessChanged;
        needsHost = state === "HOST_REVIEW_REQUIRED"; reason = result.state;
      } else if (state === "BACKUP_REVIEW_REQUIRED") {
        const result = await dependencies.backup(db, { reportId: report.id, confirmationId: work.confirmationId!,
          staffMemberId: work.staffMemberId, organizationId: reservation.property.organizationId }, now);
        state = result.recovery === "NO_VIABLE_BACKUP" ? "HOST_REVIEW_REQUIRED" : "BACKUP_OFFER_PENDING";
        reason = result.recovery; needsHost = state === "HOST_REVIEW_REQUIRED";
      } else if (["HOST_REVIEW_REQUIRED", "CONTEXT_UNAVAILABLE"].includes(state)) needsHost = true;
    } catch (error) { state = "HOST_REVIEW_REQUIRED"; reason = error instanceof Error ? error.message : "RECOVERY_FAILED"; needsHost = true; }
  }
  const key = `CLEANING_RECOVERY:${report.id}`;
  // Resolved report commands are terminal. A newer report owns a new key.
  const existing = await db.operationalIssue.findUnique({ where: { operationalKey: key }, select: { workflowState: true } });
  if (existing?.workflowState !== "RESOLVED") await dependencies.persist(db, {
    operationalKey: key, issueCode: `CLEANING_${state}`, title: needsHost ? "Cleaning needs host review" : "Pin AI cleaning recovery",
    issue: `Cleaning recovery for ${reservation.property.name}: ${reason}.`, engine: "Cleaning", visibility: "HOST",
    severity: needsHost ? "WARNING" : "INFO", workflowState: resolved ? "RESOLVED" : needsHost ? "ACTION_REQUIRED" : "WAITING",
    responsibleActor: needsHost ? "HOST" : "PIN_AI", actionRequired: needsHost,
    canAutoResolve: !needsHost, autoResolveStatus: resolved ? "SUCCEEDED" : needsHost ? "NOT_SUPPORTED" : "AVAILABLE",
    organizationId: reservation.property.organizationId, propertyId: work.propertyId, reservationId: work.reservationId,
    reservationNumber: reservation.reservationNumber, sourceType: "WORKER", actionTarget: "CLEANING",
    recommendedAction: needsHost ? "Review the reported cleaning issue, access evidence and next arrival in Mission Control." : null,
    nextAutomaticStep: resolved || needsHost ? null : "Recheck the estimate or explicit backup acceptance.",
    ...(resolved ? { resolutionCode: state, resolutionSummary: "The report workflow reached a terminal outcome; cleaning readiness is not inferred.", resolutionType: "AUTOMATIC" as const, resolvedBy: "PIN_AI" as const, resolvedAt: now } : {}),
    metadata: { reportId: report.id, cleaningWorkId: work.id, recoveryState: state, accessChanged,
      physicalAccessVerified: false, cleaningCompletionInferred: false, durationCommitmentChanged: false },
    transitionCode: `CLEANING_${state}`, transitionSummary: reason, transitionedBy: "PIN_AI", occurredAt: now, lastSignalAt: now,
  });
  if (needsHost && !work.cancelledAt && !work.supersededAt && !work.completionConfirmedAt) await dependencies.notify(db, work.id, reason);
  return { state, reason, accessChanged };
}

/** Each invocation rediscovers work from durable reports. The keyset is local
 * to this scan: failed work remains eligible on the next invocation or restart. */
export async function processCleaningIssueRecoveries(
  db: PrismaClient, now = new Date(), batchSize = 25,
  recover: (db: PrismaClient, workId: string, now: Date) => Promise<unknown> = recoverCleaningIssue,
) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new RangeError("batchSize must be a positive integer");
  let cursor: string | undefined;
  let processed = 0;
  let failures = 0;
  for (;;) {
    const works: { id: string }[] = await db.cleaningWork.findMany({
      where: { issueReports: { some: {} }, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" }, take: batchSize, select: { id: true },
    });
    for (const work of works) {
      processed++;
      try { await recover(db, work.id, now); }
      catch { failures++; console.error("[CLEANING_RECOVERY] work retained for next cycle", { workId: work.id }); }
    }
    if (works.length < batchSize) break;
    cursor = works.at(-1)!.id;
  }
  return { processed, failures };
}
