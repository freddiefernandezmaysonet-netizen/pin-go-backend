import type { PrismaClient } from "@prisma/client";
import { deliverOperationalEmail, enqueueOperationalEmail, EMAIL_REPLAY_WINDOW_MS } from "./durable-operational-email.service.js";
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
  if (!notice || !["QUEUED", "FAILED"].includes(notice.status)) return { delivered: false, reason: "not_queued" };
  const work = await prisma.cleaningWork.findUnique({ where: { id: cleaningWorkId } });
  if (!work || work.cancelledAt || work.supersededAt || work.completionConfirmedAt) {
    await prisma.cleaningHostAttentionNotice.updateMany({ where: { id: notice.id, status: { in: ["QUEUED", "FAILED"] } },
      data: { status: "OBSOLETE", lastError: "CLEANING_WORK_CLOSED" } });
    return { delivered: false, reason: "work_closed" };
  }
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
    const message = await enqueueOperationalEmail(prisma, {
      organizationId: property.organizationId, propertyId: work.propertyId, reservationId: work.reservationId,
      purpose: "cleaning", eventKey: notice.id, cleaningWorkId,
      eventAt: notice.createdAt, idempotencyKey: `cleaning-host-attention-${notice.id}`,
      mail: {
        to: recipients,
        propertyName: property.name,
        cleanerName: staff?.fullName?.trim() || "Cleaner",
        reservationNumber: reservation?.reservationNumber ?? null,
        dashboardUrl: `${origin}/properties/${encodeURIComponent(work.propertyId)}/calendar`,
        idempotencyKey: `cleaning-host-attention-${notice.id}`,
      },
    });
    const result = await deliverOperationalEmail(prisma, message);
    if (result === "FAILED_FINAL" || result === "OBSOLETE") {
      await prisma.cleaningHostAttentionNotice.updateMany({
        where: { id: notice.id, status: { in: ["QUEUED", "FAILED"] } },
        data: { status: result, lastError: result === "OBSOLETE" ? "NOTICE_NO_LONGER_ELIGIBLE" : "NOTICE_RECOVERY_EXHAUSTED" },
      });
    }
    return { delivered: result === "SENT", reason: result };
  } catch (error) {
    await prisma.cleaningHostAttentionNotice.updateMany({ where: { id: notice.id, status: { in: ["QUEUED", "FAILED"] } }, data: {
      status: "FAILED", recipientsJson: recipients, lastError: "CLEANING_NOTICE_PERSISTENCE_OR_DELIVERY_FAILED",
    }});
    return { delivered: false, reason: "provider_failed" };
  }
}

let cursor: string | undefined;
export async function processCleaningHostAttentionNotices(prisma: PrismaClient, batchSize = 20) {
  // Recover recent notices only, within the same provider idempotency window.
  const notices = await prisma.cleaningHostAttentionNotice.findMany({ where: {
    status: { in: ["QUEUED", "FAILED"] }, createdAt: { gt: new Date(Date.now() - EMAIL_REPLAY_WINDOW_MS) },
    ...(cursor ? { id: { gt: cursor } } : {}),
  }, orderBy: { id: "asc" }, take: batchSize });
  cursor = notices.length === batchSize ? notices.at(-1)!.id : undefined;
  for (const notice of notices) {
    try { await deliverCleaningHostAttentionNotice(prisma, notice.cleaningWorkId); }
    catch { console.error("[CLEANING_HOST_NOTICE] pending notice retained", { noticeId: notice.id }); }
  }
}
