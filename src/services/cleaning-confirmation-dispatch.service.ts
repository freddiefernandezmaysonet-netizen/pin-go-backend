import { PrismaClient } from "@prisma/client";
import { sendSms } from "../integrations/twilio/twilio.client";

const DISPATCH_TYPE = "CLEANING_CONFIRMATION";
const SEND_START_HOUR = 8;
const SEND_END_HOUR = 17;
const FAILED_RETRY_COOLDOWN_MINUTES = 15;

function isWithinCleaningMessageHours(timeZone: string, now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");

  return hour >= SEND_START_HOUR && hour < SEND_END_HOUR;
}

function buildConfirmUrl(token: string) {
  const rawBaseUrl =
    process.env.API_BASE_URL ??
    process.env.PUBLIC_API_BASE_URL ??
    process.env.APP_URL;

  if (!rawBaseUrl) return null;

  const baseUrl = rawBaseUrl.replace(/\/$/, "");
  return `${baseUrl}/cleaning/confirm/${token}`;
}

export async function processPendingCleaningConfirmations(
  prisma: PrismaClient,
  now: Date = new Date()
) {
  const confirmations = await prisma.cleaningConfirmation.findMany({
    where: {
      status: "PENDING",
    },
    orderBy: {
      createdAt: "asc",
    },
    take: 25,
  });

  if (confirmations.length === 0) {
    return { processed: 0, sent: 0, skipped: 0 };
  }

  let sentCount = 0;
  let skippedCount = 0;

  for (const confirmation of confirmations) {
    try {
      const [reservation, staff] = await Promise.all([
        prisma.reservation.findUnique({
          where: { id: confirmation.reservationId },
          include: {
            property: true,
          },
        }),
        prisma.staffMember.findUnique({
          where: { id: confirmation.staffMemberId },
        }),
      ]);

      if (!reservation || !staff?.phoneE164) {
        skippedCount++;
        continue;
      }

      const timezone =
        reservation.property?.timezone ??
        "America/Puerto_Rico";

      if (!isWithinCleaningMessageHours(timezone, now)) {
        skippedCount++;
        continue;
      }

      const existingSent = await prisma.messageDispatchLog.findFirst({
        where: {
          reservationId: confirmation.reservationId,
          type: DISPATCH_TYPE,
          channel: "sms",
          status: "SENT",
        },
      });

      if (existingSent) {
        skippedCount++;
        continue;
      }

      const recentFailed = await prisma.messageDispatchLog.findFirst({
        where: {
          reservationId: confirmation.reservationId,
          type: DISPATCH_TYPE,
          channel: "sms",
          status: "FAILED",
          createdAt: {
            gte: new Date(
              now.getTime() - FAILED_RETRY_COOLDOWN_MINUTES * 60_000
            ),
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      if (recentFailed) {
        skippedCount++;
        continue;
      }

      const confirmUrl = buildConfirmUrl(confirmation.token);

      if (!confirmUrl) {
        console.warn("[CLEANING_CONFIRMATION_DISPATCH] missing API base url", {
          confirmationId: confirmation.id,
          reservationId: confirmation.reservationId,
        });

        skippedCount++;
        continue;
      }

      const propertyName =
        reservation.property?.name ??
        reservation.roomName ??
        "la propiedad asignada";

      const roomName = reservation.roomName ?? "N/A";
      const staffName = staff.fullName ?? "Staff";

      const checkOutText = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      }).format(new Date(reservation.checkOut));

      const es =
        `🧼 Pin&Go Solicitud de limpieza\n` +
        `Asignado: ${staffName}\n` +
        `Propiedad: ${propertyName}\n` +
        `Unidad: ${roomName}\n` +
        `Check-out: ${checkOutText}\n\n` +
        `Confirma si estás disponible:\n${confirmUrl}`;

      const en =
        `🧼 Pin&Go Cleaning request\n` +
        `Assigned: ${staffName}\n` +
        `Property: ${propertyName}\n` +
        `Unit: ${roomName}\n` +
        `Check-out: ${checkOutText}\n\n` +
        `Confirm if you are available:\n${confirmUrl}`;

      const body = `${es}\n\n---\n\n${en}`;

      const sms = await sendSms(staff.phoneE164, body);

      await prisma.messageLog.create({
        data: {
          channel: "sms",
          to: staff.phoneE164,
          from: process.env.TWILIO_FROM_NUMBER ?? null,
          body,
          provider: "twilio",
          providerMessageId: (sms as any)?.sid ?? null,
          status: "SENT",
          reservationId: confirmation.reservationId,
          propertyId: confirmation.propertyId,
          organizationId: reservation.property?.organizationId ?? null,
        },
      });

      await prisma.messageDispatchLog.create({
        data: {
          reservationId: confirmation.reservationId,
          type: DISPATCH_TYPE,
          channel: "sms",
          status: "SENT",
        },
      });

      console.log("[CLEANING_CONFIRMATION_DISPATCH] sms sent", {
        confirmationId: confirmation.id,
        reservationId: confirmation.reservationId,
        staffMemberId: confirmation.staffMemberId,
        to: staff.phoneE164,
        timezone,
      });

      sentCount++;
    } catch (e: any) {
      console.error("[CLEANING_CONFIRMATION_DISPATCH] failed", {
        confirmationId: confirmation.id,
        reservationId: confirmation.reservationId,
        error: e?.message ?? String(e),
      });

      await prisma.messageDispatchLog
        .create({
          data: {
            reservationId: confirmation.reservationId,
            type: DISPATCH_TYPE,
            channel: "sms",
            status: "FAILED",
          },
        })
        .catch(() => {});

      skippedCount++;
    }
  }

  return {
    processed: confirmations.length,
    sent: sentCount,
    skipped: skippedCount,
  };
}