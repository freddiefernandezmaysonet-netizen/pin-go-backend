import type { PrismaClient } from "@prisma/client";
import { sendGuestContactRecoveryHostNotice } from "../lib/mailer";

const TYPE = "CHANNEX_GUEST_CONTACT_RECOVERY_REQUIRED";
const clean = (value: unknown) => String(value ?? "").trim();

/** Retry the original host notice, using current tenant/contact data and the
 * same provider idempotency key as ingestion. Never send a guest message. */
export async function retryGuestContactHostNotices(
  prisma: PrismaClient,
  options: { maxRetries: number; batchSize: number },
  send: typeof sendGuestContactRecoveryHostNotice = sendGuestContactRecoveryHostNotice,
) {
  const messages = await prisma.messageLog.findMany({
    where: {
      channel: "email", provider: "resend", status: "FAILED",
      communicationType: TYPE, retryCount: { lt: options.maxRetries },
    },
    orderBy: { createdAt: "asc" }, take: options.batchSize,
  });
  const result = { sent: 0, failed: 0, skipped: 0 };
  for (const message of messages) {
    const skip = async (reason: string) => {
      await prisma.messageLog.update({
        where: { id: message.id }, data: { status: "SKIPPED", error: reason },
      });
      result.skipped += 1;
    };
    try {
      if (!message.reservationId || !message.propertyId || !message.organizationId) {
        await skip("CONTACT_NOTICE_TENANT_SCOPE_MISSING");
        continue;
      }
      const reservation = await prisma.reservation.findFirst({
        where: {
          id: message.reservationId, propertyId: message.propertyId,
          externalProvider: "CHANNEX",
          property: { organizationId: message.organizationId },
        },
        select: {
          id: true, reservationNumber: true, source: true, status: true, checkOut: true,
          guestEmail: true, guestPhone: true,
          property: { select: { name: true } },
        },
      });
      if (!reservation || reservation.status === "CANCELLED" || reservation.checkOut <= new Date()) {
        await skip("CONTACT_NOTICE_RESERVATION_NO_LONGER_ELIGIBLE");
        continue;
      }
      const missingFields = [
        ...(!clean(reservation.guestEmail) ? ["EMAIL"] : []),
        ...(!clean(reservation.guestPhone) ? ["PHONE"] : []),
      ];
      const issue = await prisma.operationalIssue.findUnique({
        where: { operationalKey: `GUEST_CONTACT_RECOVERY:${reservation.id}` },
        select: { workflowState: true },
      });
      if (!missingFields.length || issue?.workflowState !== "ACTION_REQUIRED") {
        await skip("CONTACT_NOTICE_NO_LONGER_REQUIRED");
        continue;
      }
      // Only active organization administrators may receive this notice.
      const recipients = await prisma.dashboardUser.findMany({
        where: { organizationId: message.organizationId, isActive: true, role: "ORG_ADMIN" },
        select: { email: true, fullName: true },
      });
      const to = clean(message.to).toLowerCase();
      const recipient = recipients.find((user) => clean(user.email).toLowerCase() === to);
      if (!recipient) {
        await skip("CONTACT_NOTICE_RECIPIENT_NO_LONGER_ELIGIBLE");
        continue;
      }
      const alreadySent = await prisma.messageLog.findFirst({
        where: {
          reservationId: reservation.id, organizationId: message.organizationId,
          communicationType: TYPE, channel: "email", to, status: "SENT",
        },
        select: { id: true },
      });
      if (alreadySent) {
        await skip("CONTACT_NOTICE_ALREADY_SENT");
        continue;
      }
      const base = clean(process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
      const sent = await send({
        to, hostName: recipient.fullName,
        reservationNumber: reservation.reservationNumber ?? reservation.id,
        propertyName: reservation.property.name,
        sourceName: clean(reservation.source) || "OTA", missingFields,
        reservationDetailUrl: `${base}/reservations/${encodeURIComponent(reservation.id)}`,
        idempotencyKey: `guest-contact-recovery:${reservation.id}:${to}`,
      });
      const providerMessageId = (sent as any)?.data?.id;
      if (!providerMessageId) throw new Error("CONTACT_NOTICE_PROVIDER_ACCEPTANCE_MISSING");
      await prisma.messageLog.update({
        where: { id: message.id },
        data: {
          status: "SENT", providerMessageId, error: null,
          retryCount: { increment: 1 }, providerDeliveryStatus: null,
          providerStatusUpdatedAt: null, providerErrorCode: null,
          providerErrorMessage: null, deliveredAt: null,
        },
      });
      result.sent += 1;
    } catch (error) {
      await prisma.messageLog.update({
        where: { id: message.id },
        data: {
          status: "FAILED", retryCount: { increment: 1 },
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        },
      });
      result.failed += 1;
    }
  }
  return result;
}
