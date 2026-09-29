import type { PrismaClient } from "@prisma/client";
import { sendCleaningHostAttentionEmail } from "../lib/mailer.js";
import { resolveCleaningHostAttentionRecipients } from "./cleaning-followup-host-recipient.service.js";

function dashboardOrigin() {
  const raw = process.env.DASHBOARD_URL ?? process.env.APP_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch { return null; }
}

export async function deliverCleaningHostAttentionNotice(
  prisma: PrismaClient,
  cleaningWorkId: string,
) {
  const notice = await prisma.cleaningHostAttentionNotice.findUnique({ where: { cleaningWorkId } });
  if (!notice || notice.status !== "QUEUED") return { delivered: false, reason: "not_queued" };
  const work = await prisma.cleaningWork.findUnique({ where: { id: cleaningWorkId } });
  if (!work || work.cancelledAt || work.supersededAt || work.completionConfirmedAt) return { delivered: false, reason: "work_closed" };
  const [property, staff, reservation] = await Promise.all([
    prisma.property.findUnique({ where: { id: work.propertyId }, select: { name: true, organizationId: true } }),
    prisma.staffMember.findUnique({ where: { id: work.staffMemberId }, select: { fullName: true } }),
    prisma.reservation.findUnique({ where: { id: work.reservationId }, select: { reservationNumber: true } }),
  ]);
  const origin = dashboardOrigin();
  if (!property || !origin) return { delivered: false, reason: "context_missing" };
  const recipients = await resolveCleaningHostAttentionRecipients(prisma, property.organizationId);
  if (!recipients.length) return { delivered: false, reason: "recipient_missing" };
  try {
    const sent = await sendCleaningHostAttentionEmail({
      to: recipients,
      propertyName: property.name,
      cleanerName: staff?.fullName?.trim() || "Cleaner",
      reservationNumber: reservation?.reservationNumber ?? null,
      dashboardUrl: `${origin}/properties/${encodeURIComponent(work.propertyId)}/calendar`,
      idempotencyKey: `cleaning-host-attention-${notice.id}`,
    });
    await prisma.cleaningHostAttentionNotice.update({ where: { id: notice.id }, data: {
      status: "SENT", recipientsJson: recipients, providerMessageId: sent.providerMessageId, sentAt: new Date(), lastError: null,
    }});
    return { delivered: true, reason: "sent" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.cleaningHostAttentionNotice.update({ where: { id: notice.id }, data: {
      status: "FAILED", recipientsJson: recipients, lastError: message.slice(0, 8000),
    }});
    return { delivered: false, reason: "provider_failed" };
  }
}
