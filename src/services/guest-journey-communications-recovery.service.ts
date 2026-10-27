import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { persistAuditEntry } from "../apms/audit-persistence.service";
import { syncGuestJourneyCommunicationMissionControl } from "./guest-journey-communications-mission-control.service";

type ReceiptEvidence = {
  status: string | null;
  channel: string;
  provider: string;
  providerMessageId: string | null;
  providerDeliveryStatus: string | null;
  providerStatusUpdatedAt: Date | null;
  deliveredAt: Date | null;
};

export function hasConfirmedCommunicationReceipt(message: ReceiptEvidence, startedAt: Date, now: Date): boolean {
  const provider = message.channel === "sms" ? "twilio" : message.channel === "email" ? "resend" : null;
  const dates = [startedAt, now, message.deliveredAt, message.providerStatusUpdatedAt];
  return !!provider && message.provider === provider &&
    ["E7_SENDING", "SENT"].includes(message.status ?? "") &&
    !!message.providerMessageId?.trim() &&
    ["DELIVERED", "READ"].includes(message.providerDeliveryStatus ?? "") &&
    dates.every(date => date instanceof Date && Number.isFinite(date.getTime())) &&
    message.deliveredAt!.getTime() >= startedAt.getTime() &&
    message.providerStatusUpdatedAt!.getTime() >= message.deliveredAt!.getTime() &&
    message.providerStatusUpdatedAt!.getTime() <= now.getTime();
}

/** DB-only reconciliation. Never sends, resets a send budget or rewrites an
 * earlier attempt. Serializable CAS plus the immutable audit entry fence the
 * whole transition; no lease spanning an external call is needed here.
 * Production workers do not invoke this service until a separate rollout.
 */
export async function reconcileGuestJourneyCommunicationEvidence(
  prisma: PrismaClient,
  input: { intentId: string; organizationId: string; propertyId: string; now?: Date },
  dependencies = { persistAudit: persistAuditEntry },
) {
  const now = input.now ?? new Date();
  if (!input.intentId.trim() || !input.organizationId.trim() || !input.propertyId.trim() || !Number.isFinite(now.getTime())) {
    throw new Error("COMMUNICATION_RECOVERY_SCOPE_REQUIRED");
  }
  return prisma.$transaction(async tx => {
    const intent = await tx.guestJourneyCoordinationIntent.findUnique({
      where: { id: input.intentId }, include: { reservation: { select: {
        propertyId: true, property: { select: { organizationId: true } },
      } } },
    });
    if (!intent) throw new Error("COMMUNICATION_RECOVERY_INTENT_NOT_FOUND");
    if (intent.reservation.propertyId !== input.propertyId ||
        intent.reservation.property.organizationId !== input.organizationId) {
      throw new Error("COMMUNICATION_RECOVERY_SCOPE_MISMATCH");
    }
    if (intent.targetEngine !== "COMMUNICATIONS" ||
        !["REQUEST_COMMUNICATION", "REQUEST_COMMUNICATION_RETRY"].includes(intent.intentType) ||
        intent.expectedOutcomeCode !== "COMMUNICATION_DELIVERY_FINAL") {
      throw new Error("COMMUNICATION_RECOVERY_CONTRACT_MISMATCH");
    }
    if (intent.status !== "WAITING_FOR_EVIDENCE") return { action: "NOT_REQUIRED", providerCalls: 0 } as const;
    if (intent.leaseToken || intent.leaseExpiresAt || intent.claimedAt) {
      throw new Error("COMMUNICATION_RECOVERY_LIVE_FENCE_REJECTED");
    }
    const scope = { organizationId: input.organizationId, propertyId: input.propertyId };
    const waiting = async (reason: string) => {
      await syncGuestJourneyCommunicationMissionControl(tx, intent.id, scope);
      return { action: "WAITING", reason, providerCalls: 0 } as const;
    };
    const payload = intent.payload && typeof intent.payload === "object" && !Array.isArray(intent.payload)
      ? intent.payload : {};
    if (typeof payload.messageLogId !== "string" || typeof payload.communicationType !== "string" ||
        !["sms", "email"].includes(String(payload.channel))) return waiting("CORRELATION_MISSING");
    const message = await tx.messageLog.findFirst({ where: {
      id: payload.messageLogId, ...scope, reservationId: intent.reservationId,
      communicationType: payload.communicationType, channel: String(payload.channel),
    } });
    const attempt = await tx.guestJourneyCoordinationIntentAttempt.findUnique({ where: {
      intentId_attemptNumber: { intentId: intent.id, attemptNumber: intent.claimCount },
    } });
    if (!message || !attempt || attempt.outcome !== "WAITING_FOR_EVIDENCE" ||
        attempt.targetEngine !== "COMMUNICATIONS" || attempt.intentType !== intent.intentType) {
      return waiting("CORRELATED_ATTEMPT_MISSING");
    }
    if (!hasConfirmedCommunicationReceipt(message, attempt.startedAt, now)) return waiting("DELIVERY_RECEIPT_REQUIRED");
    const matches = await tx.messageLog.count({ where: {
      provider: message.provider, providerMessageId: message.providerMessageId,
    } });
    if (matches !== 1) return waiting("PROVIDER_CORRELATION_AMBIGUOUS");
    const fingerprint = createHash("sha256").update(JSON.stringify({
      messageLogId: message.id, provider: message.provider, providerMessageId: message.providerMessageId,
      deliveryStatus: message.providerDeliveryStatus, deliveredAt: message.deliveredAt,
      receiptAt: message.providerStatusUpdatedAt, attemptId: attempt.id,
    })).digest("hex");
    const changed = await tx.guestJourneyCoordinationIntent.updateMany({ where: {
      id: intent.id, status: "WAITING_FOR_EVIDENCE", claimCount: intent.claimCount,
      updatedAt: intent.updatedAt, leaseToken: null, leaseExpiresAt: null,
    }, data: { status: "SUCCEEDED", succeededAt: now, nextActionAt: null,
      lastError: null, outcomeEvidenceFingerprint: fingerprint } });
    if (changed.count !== 1) throw new Error("COMMUNICATION_RECOVERY_COMPARE_AND_SET_LOST");
    const persisted = await tx.messageLog.updateMany({ where: {
      id: message.id, status: message.status, providerMessageId: message.providerMessageId,
      providerDeliveryStatus: message.providerDeliveryStatus, deliveredAt: message.deliveredAt,
    }, data: { status: "SENT", error: null } });
    if (persisted.count !== 1) throw new Error("COMMUNICATION_RECOVERY_RECEIPT_FENCE_LOST");
    await dependencies.persistAudit(tx, {
      engine: "COMMUNICATIONS", entityType: "RESERVATION", entityId: intent.reservationId,
      decisionId: `guest-journey:communications:${intent.id}:${intent.claimCount}:receipt-recovered`,
      eventType: "ACTION_COMPLETED", status: "SUCCESS", severity: "INFO",
      summary: "Communication recovered from a confirmed delivery receipt without another send.",
      reason: "COMMUNICATION_DELIVERY_RECEIPT_CONFIRMED", startedAt: now, completedAt: now, durationMs: 0,
      metadata: { ...scope, reservationId: intent.reservationId, intentId: intent.id,
        messageLogId: message.id, attemptId: attempt.id, attemptNumber: intent.claimCount,
        leaseTokenFingerprint: attempt.leaseTokenFingerprint, outcomeEvidenceFingerprint: fingerprint,
        providerCalls: 0, deliveryStatus: message.providerDeliveryStatus },
    });
    await syncGuestJourneyCommunicationMissionControl(tx, intent.id, scope);
    return { action: "RECOVERED", providerCalls: 0, messageLogId: message.id } as const;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
