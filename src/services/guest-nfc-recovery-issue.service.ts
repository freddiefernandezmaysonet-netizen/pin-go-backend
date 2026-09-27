import type { PrismaClient } from "@prisma/client";
import { upsertOperationalIssue } from "../apms/operational-intelligence.service";
import { guestNfcNextRetry, guestNfcRetryable } from "./guest-nfc-recovery.policy";

export async function reconcileGuestNfcRecoveryIssues(prisma: PrismaClient, now: Date,
  persistIssue: typeof upsertOperationalIssue = upsertOperationalIssue) {
  // Also repair missing issues for failures persisted before this release.
  // Read pages independently from the provisioning batch; never issue hardware calls.
  const openIssues = await prisma.operationalIssue.findMany({
    where: { operationalKey: { startsWith: "GUEST_NFC_ACTIVATION:" }, workflowState: { not: "RESOLVED" } },
    select: { operationalKey: true },
  });
  const openAssignmentIds = openIssues.map(issue => issue.operationalKey.slice("GUEST_NFC_ACTIVATION:".length));
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.nfcAssignment.findMany({
      where: { role: "GUEST", OR: [
        { status: { in: ["FAILED", "PROVISIONING"] },
          Reservation: { status: "ACTIVE", checkOut: { gt: now } } },
        { id: { in: openAssignmentIds } },
      ] },
      include: { Reservation: { include: { property: true } } },
      orderBy: { id: "asc" }, take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const a of rows) {
      const reservation = a.Reservation;
      const active = reservation.status === "ACTIVE" && reservation.checkOut > now &&
        a.status === "ACTIVE" && a.endsAt >= reservation.checkOut;
      const ended = a.status === "ENDED" || reservation.status !== "ACTIVE" || reservation.checkOut <= now;
      const failed = a.status === "FAILED" || (a.status === "PROVISIONING" && a.retryCount >= 5 &&
        (!a.provisioningStartedAt || a.provisioningStartedAt.getTime() <= now.getTime() - 5 * 60_000));
      if (!active && !ended && !failed) continue;
      const key = `GUEST_NFC_ACTIVATION:${a.id}`;
      const existing = await prisma.operationalIssue.findUnique({ where: { operationalKey: key } });
      const resolved = active || ended;
      if (resolved && (!existing || existing.workflowState === "RESOLVED")) continue;
      // A new activation cycle needs an explicit reopen, not an implicit override.
      if (!resolved && existing?.workflowState === "RESOLVED") continue;
      const nextRetry = !resolved && guestNfcRetryable(a.lastError ?? "")
        ? guestNfcNextRetry(a.retryCount, a.updatedAt) : null;
      const signature = `${a.status}:${a.retryCount}:${a.updatedAt.toISOString()}:${resolved}`;
      if (existing?.metadata && typeof existing.metadata === "object" &&
          !Array.isArray(existing.metadata) && existing.metadata.signature === signature) continue;
      await persistIssue(prisma, {
        operationalKey: key, issueCode: resolved ? "GUEST_NFC_ACTIVATION_CLOSED" : "GUEST_NFC_ACTIVATION_FAILED",
        title: resolved ? "Guest card incident closed" : "Guest card activation needs attention",
        issue: resolved ? (active ? "The provider confirmed the guest card access period." : "The assignment or stay has ended; access was not certified.")
          : "Pin&Go could not confirm activation of a guest NFC card.",
        operationalImpact: resolved ? null : "The guest may be unable to enter using this card.",
        recommendedAction: resolved ? null : "Check the lock, gateway and card in TTLock and arrange verified guest access if needed.",
        nextAutomaticStep: nextRetry ? `Another bounded attempt is due at ${nextRetry.toISOString()}.` : null,
        engine: "ACCESS", severity: resolved ? "INFO" : "CRITICAL",
        workflowState: resolved ? "RESOLVED" : "ACTION_REQUIRED",
        visibility: resolved ? "SYSTEM" : "HOST", responsibleActor: resolved ? "PIN_GO" : "HOST",
        actionRequired: !resolved, canAutoResolve: active || Boolean(nextRetry),
        autoResolveStatus: active ? "SUCCEEDED" : nextRetry ? "AVAILABLE" : "NOT_SUPPORTED",
        organizationId: reservation.property.organizationId, propertyId: reservation.propertyId,
        reservationId: reservation.id, reservationNumber: reservation.reservationNumber,
        sourceType: "WORKER", actionTarget: "ACCESS",
        ...(resolved ? { resolutionCode: active ? "GUEST_NFC_RECOVERED" : "GUEST_NFC_WINDOW_ENDED",
          resolutionSummary: active ? "Provider activation succeeded." : "Access window ended without certifying activation.",
          resolutionType: active ? "AUTOMATIC" as const : "EXPIRED" as const,
          resolvedBy: "PIN_GO" as const, resolvedAt: now } : {}),
        metadata: { assignmentId: a.id, attempts: a.retryCount, signature },
        transitionCode: resolved ? "GUEST_NFC_INCIDENT_CLOSED" : "GUEST_NFC_HOST_ATTENTION",
        transitionSummary: resolved ? "The guest card incident was closed." : "Guest card activation failure requires attention.",
        transitionedBy: "PIN_GO", occurredAt: now, lastSignalAt: now,
      });
    }
    if (rows.length < 100) break;
    cursor = rows[rows.length - 1]!.id;
  }
}
