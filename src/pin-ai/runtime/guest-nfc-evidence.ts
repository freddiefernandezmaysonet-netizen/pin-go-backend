import type { PrismaClient } from "@prisma/client";
import { guestNfcNextRetry, GUEST_NFC_MAX_ATTEMPTS, GUEST_NFC_GENERIC_FAILURE } from "../../services/guest-nfc-recovery.policy.js";

export type GuestNfcEvidenceReader = Pick<PrismaClient, "nfcAssignment" | "operationalIssue">;

/** Reads persisted evidence only. Never contacts TTLock or modifies access. */
export async function readGuestNfcEvidence(db: GuestNfcEvidenceReader, scope: {
  organizationId: string; propertyId: string; reservationId: string;
}, now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error("PIN_AI_ACCESS_EVIDENCE_TIME_INVALID");
  const assignments = await db.nfcAssignment.findMany({
    where: { reservationId: scope.reservationId, role: "GUEST",
      Reservation: { propertyId: scope.propertyId, property: { organizationId: scope.organizationId } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 101,
    select: { id: true, status: true, startsAt: true, endsAt: true, lastError: true,
      retryCount: true, updatedAt: true, provisionedAt: true, provisioningStartedAt: true,
      Reservation: { select: { status: true, checkIn: true, checkOut: true } } },
  });
  const rows = assignments.slice(0, 100);
  const issues = rows.length ? await db.operationalIssue.findMany({
    where: { ...scope, engine: "ACCESS",
      operationalKey: { in: rows.map(a => `GUEST_NFC_ACTIVATION:${a.id}`) } },
    select: { operationalKey: true, workflowState: true, visibility: true,
      actionRequired: true, resolvedAt: true, resolutionCode: true },
  }) : [];
  return {
    evidenceSource: "PERSISTED_GUEST_NFC_ASSIGNMENTS",
    observedAt: now.toISOString(), truncated: assignments.length > 100,
    recordCount: rows.length,
    cards: rows.map((a, index) => {
      const issue = issues.find(i => i.operationalKey === `GUEST_NFC_ACTIVATION:${a.id}`);
      const stayOpen = a.Reservation.status === "ACTIVE" && a.Reservation.checkOut > now;
      // Match the canonical worker's persisted failed-record selection.
      const retryDue = stayOpen && a.status === "FAILED" &&
        (a.lastError?.startsWith("RETRYABLE:") || a.lastError === GUEST_NFC_GENERIC_FAILURE)
        ? guestNfcNextRetry(a.retryCount, a.updatedAt) : null;
      const eligibleAt = new Date(a.Reservation.checkIn.getTime() - 2 * 60 * 60_000);
      const nextAttemptNotBefore = retryDue
        ? new Date(Math.max(retryDue.getTime(), eligibleAt.getTime())).toISOString() : null;
      return {
        cardNumber: index + 1, credentialKind: "PHYSICAL_NFC_CARD",
        assignmentStatus: a.status,
        startsAt: a.startsAt, endsAt: a.endsAt,
        desiredStartsAt: a.Reservation.checkIn, desiredEndsAt: a.Reservation.checkOut,
        providerActivationRecorded: a.status === "ACTIVE" && a.provisionedAt !== null,
        providerActivationRecordedAt: a.provisionedAt,
        coversCurrentStay: a.status === "ACTIVE" && stayOpen &&
          a.startsAt <= a.Reservation.checkIn && a.endsAt >= a.Reservation.checkOut,
        usableByRecordedWindowNow: a.status === "ACTIVE" && stayOpen && a.startsAt <= now && a.endsAt > now,
        physicalUseVerified: false,
        attempts: a.retryCount,
        retry: { eligible: nextAttemptNotBefore !== null, nextAttemptNotBefore,
          exhausted: a.retryCount >= GUEST_NFC_MAX_ATTEMPTS && a.status !== "ACTIVE",
          timingGuaranteed: false },
        incident: { recorded: Boolean(issue),
          hostAttentionRecorded: Boolean(issue && issue.workflowState !== "RESOLVED" &&
            issue.visibility === "HOST" && issue.actionRequired),
          resolved: issue?.workflowState === "RESOLVED",
          recoveryRecorded: issue?.workflowState === "RESOLVED" && issue.resolutionCode === "GUEST_NFC_RECOVERED",
          resolvedAt: issue?.resolvedAt ?? null,
          hostNotificationDeliveryVerified: false },
      };
    }),
    interpretation: "No records means no NFC evidence, not failed activation. FAILED means activation failed. ACTIVE and provisionedAt record provider success, not a live connectivity check or a physical card test. These are physical cards; phone NFC settings do not activate them. A recorded incident is not proof of host notification delivery. Retry times are earliest eligibility, not guaranteed execution. Do not infer success from a resolved incident when the current assignment is FAILED.",
    operationalWrites: false, actionsExecuted: false,
  };
}
