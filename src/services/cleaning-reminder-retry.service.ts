import type { PrismaClient } from "@prisma/client";
import { evaluateCleaningFollowup } from "./cleaning-followup.policy.js";

type Message = { id: string; communicationType?: string | null; body: string; to: string;
  reservationId?: string | null; propertyId?: string | null; organizationId?: string | null };

/** Suppress obsolete existing reminders; never rewrite a former cleaner's SMS for a backup. */
export async function retireObsoleteCleaningReminder(db: PrismaClient, message: Message, now = new Date()): Promise<boolean> {
  // These retired routine families historically lacked communicationType.
  // Match only their exact existing template prefixes, preserving other SMS.
  if (/^Pin&Go (?:cleaning ready\.|limpieza lista\.|cleaning start\.|inicio de limpieza\.|cleaning done\.|limpieza terminada\.)/.test(message.body)) {
    await db.messageLog.updateMany({ where: { id: message.id, status: "FAILED" },
      data: { status: "OBSOLETE", error: "CLEANING_ROUTINE_SMS_RETIRED" } });
    return true;
  }
  const kind = message.communicationType === "CLEANING_FOLLOWUP_START_REMINDER" ? "START_REMINDER"
    : message.communicationType === "CLEANING_FOLLOWUP_COMPLETION_REMINDER" ? "COMPLETION_REMINDER" : null;
  if (!kind) return false;
  let reason = "CLEANING_REMINDER_CONTEXT_UNVERIFIED";
  const tokens = new Set<string>();
  for (const link of message.body.match(/https:\/\/\S+/g) ?? []) {
    try {
      const path = new URL(link).pathname;
      const match = /^\/cleaning\/confirm\/([A-Za-z0-9_-]+)$/.exec(path);
      if (match) tokens.add(match[1]!);
    } catch { /* Invalid legacy context is not guessed. */ }
  }
  if (tokens.size === 1 && message.reservationId && message.propertyId && message.organizationId) {
    const offers = await db.cleaningConfirmation.findMany({ where: {
      reservationId: message.reservationId, propertyId: message.propertyId,
      status: { in: ["PENDING", "CONFIRMED"] },
    }, take: 2 });
    const offer = offers.length === 1 ? offers[0] : null;
    if (offer?.status === "CONFIRMED" && tokens.has(offer.token)) {
      const [reservation, staff, works] = await Promise.all([
        db.reservation.findFirst({ where: { id: message.reservationId, propertyId: message.propertyId,
          status: "ACTIVE", property: { organizationId: message.organizationId, status: "ACTIVE" } } }),
        db.staffMember.findFirst({ where: { id: offer.staffMemberId, organizationId: message.organizationId,
          isActive: true, phoneE164: message.to } }),
        db.cleaningWork.findMany({ where: { confirmationId: offer.id, staffMemberId: offer.staffMemberId,
          reservationId: message.reservationId, propertyId: message.propertyId }, take: 2 }),
      ]);
      const work = works.length === 1 ? works[0] : null;
      if (reservation && staff && work && !work.cancelledAt && !work.supersededAt && work.timingConsentAcceptedAt) {
        const phase = evaluateCleaningFollowup({ scheduledStartAt: work.scheduledStartAt,
          durationMinutes: work.durationCommitmentMinutes, startConfirmationGraceMinutes: work.startConfirmationGraceMinutes,
          followupGraceMinutes: work.followupGraceMinutes, startConfirmedAt: work.startConfirmedAt,
          completionConfirmedAt: work.completionConfirmedAt, cancelled: false }, now);
        if (phase.decision === `${kind}_DUE`) return false;
        reason = "CLEANING_REMINDER_PHASE_OBSOLETE";
      }
    }
  }
  await db.messageLog.updateMany({ where: { id: message.id, status: "FAILED" },
    data: { status: "OBSOLETE", error: reason } });
  return true;
}
