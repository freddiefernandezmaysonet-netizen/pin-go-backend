import type { PrismaClient } from "@prisma/client";
import { sendLoggedSms } from "./messaging.service.js";
import { buildCleanerFollowupSms } from "./cleaning-followup-sms-body.service.js";
import { resolveStaffLanguage } from "./staff-language.service.js";

function baseUrl() {
  const raw = process.env.API_BASE_URL ?? process.env.PUBLIC_API_BASE_URL ?? process.env.APP_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (process.env.NODE_ENV === "production" && u.protocol !== "https:") return null;
    return u.toString().replace(/\/+$/, "");
  } catch { return null; }
}

export async function deliverClaimedCleanerFollowup(
  prisma: PrismaClient,
  receiptId: string,
) {
  const receipt = await prisma.cleaningFollowupReceipt.findUnique({ where: { id: receiptId } });
  if (!receipt || receipt.deliveryStatus !== "CLAIMED") return { delivered: false, reason: "not_claimed" };
  if (receipt.kind === "HOST_ATTENTION") return { delivered: false, reason: "host_attention_not_cleaner_sms" };

  const work = await prisma.cleaningWork.findUnique({ where: { id: receipt.cleaningWorkId } });
  if (!work || work.cancelledAt || work.supersededAt || work.completionConfirmedAt) {
    return { delivered: false, reason: "work_closed" };
  }
  if (receipt.kind === "START_REMINDER" && work.startConfirmedAt) return { delivered: false, reason: "start_already_confirmed" };

  const [staff, reservation] = await Promise.all([
    prisma.staffMember.findUnique({ where: { id: work.staffMemberId }, select: { phoneE164: true } }),
    prisma.reservation.findUnique({ where: { id: work.reservationId }, select: {
      id: true, propertyId: true, property: { select: { name: true, organizationId: true } },
    } }),
  ]);
  const confirmation = work.confirmationId ? await prisma.cleaningConfirmation.findUnique({ where: { id: work.confirmationId }, select: { token: true } }) : null;
  const base = baseUrl();
  if (!staff?.phoneE164 || !reservation || !confirmation?.token || !base) {
    return { delivered: false, reason: "delivery_context_missing" };
  }
  const body = buildCleanerFollowupSms({
    kind: receipt.kind,
    propertyName: reservation.property.name,
    actionUrl: `${base}/cleaning/confirm/${confirmation.token}`,
    language: resolveStaffLanguage(staff.preferredLanguage),
  });
  const sent = await sendLoggedSms({
    prisma,
    to: staff.phoneE164,
    body,
    reservationId: reservation.id,
    propertyId: reservation.propertyId,
    organizationId: reservation.property.organizationId,
    communicationType: `CLEANING_FOLLOWUP_${receipt.kind}`,
  });
  if (!sent.ok) {
    await prisma.cleaningFollowupReceipt.update({
      where: { id: receipt.id },
      data: { deliveryStatus: "FAILED", lastError: sent.error ?? "SMS_FAILED" },
    });
    return { delivered: false, reason: "provider_failed" };
  }
  await prisma.cleaningFollowupReceipt.update({
    where: { id: receipt.id },
    data: { deliveryStatus: "SENT", deliveredAt: new Date(), providerMessageId: sent.sid ?? null, lastError: null },
  });
  return { delivered: true, reason: "sent" };
}
