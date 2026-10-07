import type { Prisma } from "@prisma/client";
import { readCleaningActionWindow } from "./cleaning-action-window.js";
import { DEFAULT_CLEANING_RECOVERY_POLICY, parseCleaningRecoveryPolicy } from "./cleaning-recovery-policy.service.js";
import { readCleanerAccessWindow } from "./cleaner-access-window.service.js";

type Work = { id: string; reservationId: string; propertyId: string; staffMemberId: string; confirmationId: string | null; scheduledStartAt: Date; durationCommitmentMinutes: number; startConfirmedAt: Date | null; completionConfirmedAt: Date | null; cancelledAt: Date | null; supersededAt: Date | null; timingConsentAcceptedAt: Date | null };
type Report = { kind: string; estimatedAt: Date | null; reportedAt: Date };
type Policy = { revision: number; maxDelayMinutes: number; maxAccessExtensionMinutes: number; arrivalSafetyMarginMinutes: number };
export type CleaningIssueAssessmentInput = { work: Work; report: Report | null; policy: Policy; accessEnd: Date; latestStartAt: Date; nextCheckIn: Date | null; now: Date; extensionLimitStartsAt?: Date };
export function assessCleaningIssue(input: CleaningIssueAssessmentInput) {
  const result = (decision: string, reason: string, estimatedFinishAt: Date | null = null, proposedAccessEnd: Date | null = null) => ({
    decision, reason, estimatedFinishAt, proposedAccessEnd, policyRevision: input.policy.revision,
    authorizationGranted: false, actionsExecuted: false, accessChanged: false,
  });
  const { work, report, policy, now, accessEnd, latestStartAt, nextCheckIn } = input;
  if (!report) return result("NO_REPORT", "NO_RECORDED_ISSUE");
  if (work.completionConfirmedAt || work.cancelledAt || work.supersededAt) return result("REPORT_SUPERSEDED", "WORK_CLOSED");
  const dates = [now, accessEnd, latestStartAt, work.scheduledStartAt, report.reportedAt, ...(nextCheckIn ? [nextCheckIn] : []), ...(work.startConfirmedAt ? [work.startConfirmedAt] : [])];
  try { parseCleaningRecoveryPolicy(policy); }
  catch { return result("CONTEXT_UNAVAILABLE", "INVALID_POLICY"); }
  if (dates.some(date => !Number.isFinite(date.getTime())) || latestStartAt <= work.scheduledStartAt || report.reportedAt > now || (work.startConfirmedAt && work.startConfirmedAt > now)) return result("CONTEXT_UNAVAILABLE", "INVALID_TIMING_CONTEXT");
  if (!work.timingConsentAcceptedAt) return result("CLEANER_ACTION_REQUIRED", "TIMING_CONSENT_REQUIRED");
  if (report.kind === "DELAY" && work.startConfirmedAt) return result("REPORT_SUPERSEDED", "START_RECORDED");
  if (report.kind !== "DELAY" && !work.startConfirmedAt) return result("CONTEXT_UNAVAILABLE", "START_EVIDENCE_MISSING");
  if (report.kind === "INCOMPLETE") return result("BACKUP_REVIEW_REQUIRED", "WORK_REPORTED_INCOMPLETE");
  if (!["DELAY", "MORE_TIME"].includes(report.kind) || !report.estimatedAt || !Number.isFinite(report.estimatedAt.getTime()) || !Number.isFinite(now.getTime()) || !Number.isFinite(accessEnd.getTime()) ||
      !Number.isSafeInteger(work.durationCommitmentMinutes) || work.durationCommitmentMinutes <= 0) return result("CONTEXT_UNAVAILABLE", "INVALID_TIMING_CONTEXT");
  if (report.estimatedAt <= now) return result("HOST_REVIEW_REQUIRED", "REPORTED_ESTIMATE_ELAPSED");
  const arrival = report.kind === "DELAY" ? new Date(Math.max(report.estimatedAt.getTime(), work.scheduledStartAt.getTime())) : null;
  const finish = arrival ? new Date(arrival.getTime() + work.durationCommitmentMinutes * 60000) : report.estimatedAt;
  if (arrival && (arrival >= latestStartAt || now >= latestStartAt)) return result("HOST_REVIEW_REQUIRED", "START_WINDOW_CLOSED", finish);
  if (arrival && arrival.getTime() - work.scheduledStartAt.getTime() > policy.maxDelayMinutes * 60000) return result("HOST_REVIEW_REQUIRED", "HOST_DELAY_LIMIT_EXCEEDED", finish);
  if (nextCheckIn && finish.getTime() >= nextCheckIn.getTime() - policy.arrivalSafetyMarginMinutes * 60000) return result("HOST_REVIEW_REQUIRED", "NEXT_ARRIVAL_AT_RISK", finish);
  if (finish < accessEnd) return result("FOLLOW_ESTIMATE", "WITHIN_EXISTING_WINDOW", finish);
  if (nextCheckIn) return result("HOST_REVIEW_REQUIRED", "ACCESS_EXTENSION_BLOCKED_BY_NEXT_CHECKIN", finish);
  // Automatic extension is only considered for explicitly started work.
  if (!work.startConfirmedAt) return result("HOST_REVIEW_REQUIRED", "EXTENSION_REQUIRES_STARTED_WORK", finish);
  // Completion is exclusive of the access bound; leave one minute after the estimate.
  const proposed = new Date(finish.getTime() + 60000);
  if (policy.maxAccessExtensionMinutes === 0 || proposed.getTime() - (input.extensionLimitStartsAt ?? accessEnd).getTime() > policy.maxAccessExtensionMinutes * 60000) return result("HOST_REVIEW_REQUIRED", "HOST_EXTENSION_LIMIT_EXCEEDED", finish);
  return result("ACCESS_EXTENSION_REQUIRED", "WITHIN_HOST_LIMIT_NO_NEXT_CHECKIN", finish, proposed);
}
/** Read-only assessment of the latest declaration; no remote command or completion inference. */
export async function assessLatestCleaningIssue(tx: Prisma.TransactionClient, work: Work, now = new Date()) {
  const report = await tx.cleaningWorkIssueReport.findFirst({ where: { cleaningWorkId: work.id }, orderBy: [{ reportedAt: "desc" }, { id: "desc" }] });
  if (!report) return null;
  try {
    const [policy, window, next, assignment] = await Promise.all([
      tx.cleaningRecoveryPolicy.findUnique({ where: { propertyId: work.propertyId } }),
      readCleaningActionWindow(tx, work),
      tx.reservation.findFirst({ where: { id: work.reservationId, propertyId: work.propertyId }, select: { checkOut: true } }).then(reservation => reservation ? tx.reservation.findFirst({ where: { propertyId: work.propertyId, id: { not: work.reservationId }, status: { not: "CANCELLED" }, checkOut: { gt: reservation.checkOut } }, orderBy: { checkIn: "asc" }, select: { checkIn: true } }) : null),
      tx.staffAssignment.findUnique({ where: { reservationId_staffMemberId: { reservationId: work.reservationId, staffMemberId: work.staffMemberId } }, select: { endsAt: true } }),
    ]);
    if (!assignment) throw new Error("ACCESS_WINDOW_MISSING");
    let effectiveEnd = window.latestStartAt;
    // Full clients can verify an applied extension. Narrow read-only adapters
    // retain the canonical base window and never invent an execution receipt.
    if (tx.cleaningAccessExtension) {
      const reservation = await tx.reservation.findFirst({ where: { id: work.reservationId, propertyId: work.propertyId }, include: { property: true } });
      if (reservation) effectiveEnd = (await readCleanerAccessWindow(tx, reservation)).endsAt;
    }
    const assessment = assessCleaningIssue({ work, report, policy: policy ?? DEFAULT_CLEANING_RECOVERY_POLICY,
      accessEnd: new Date(Math.min(assignment.endsAt.getTime(), effectiveEnd.getTime())), latestStartAt: window.latestStartAt,
      extensionLimitStartsAt: window.latestStartAt, nextCheckIn: next?.checkIn ?? null, now });
    const extension = tx.cleaningAccessExtension && await tx.cleaningAccessExtension.findUnique({ where: { reportId: report.id } });
    if (extension?.state === "APPLIED" && assessment.decision === "FOLLOW_ESTIMATE" && effectiveEnd >= extension.proposedEndsAt && assignment.endsAt >= extension.proposedEndsAt &&
        await tx.nfcAssignment.findFirst({ where: { id: extension.nfcAssignmentId, reservationId: work.reservationId,
          role: "CLEANING", status: "ACTIVE", startsAt: extension.startsAt, endsAt: extension.proposedEndsAt }, select: { id: true } })) {
      return { ...assessment, decision: "ACCESS_EXTENDED", reason: "PROVIDER_ACKNOWLEDGED_EXTENSION", proposedAccessEnd: extension.proposedEndsAt,
        actionsExecuted: true, accessChanged: true, authorizationGranted: false };
    }
    if (extension && ["UNCERTAIN", "ABORTED"].includes(extension.state)) return { ...assessment,
      decision: "HOST_REVIEW_REQUIRED", reason: `ACCESS_EXTENSION_${extension.state}` };
    if (extension && ["PREPARED", "SENDING"].includes(extension.state)) return { ...assessment,
      decision: "ACCESS_EXTENSION_PENDING", reason: "PROVIDER_RECEIPT_PENDING" };
    return assessment;
  } catch {
    return { decision: "CONTEXT_UNAVAILABLE", reason: "CURRENT_WINDOW_UNVERIFIED", estimatedFinishAt: null, proposedAccessEnd: null, policyRevision: null, authorizationGranted: false, actionsExecuted: false, accessChanged: false };
  }
}
