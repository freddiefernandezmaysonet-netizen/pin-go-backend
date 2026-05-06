import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import { sendSms } from "../integrations/twilio/twilio.client";
import { selectNextStaffForProperty } from "./staff-selection.service";

const DISPATCH_TYPE = "CLEANING_CONFIRMATION";
const SEND_START_HOUR = 8;
const SEND_END_HOUR = 17;
const FAILED_RETRY_COOLDOWN_MINUTES = 15;
const FALLBACK_AFTER_MINUTES = 60;

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

async function sendCleaningConfirmationSms(params: {
  prisma: PrismaClient;
  confirmation: {
    id: string;
    reservationId: string;
    propertyId: string;
    staffMemberId: string;
    token: string;
  };
  now: Date;
}) {
  const { prisma, confirmation, now } = params;

  const [reservation, staff] = await Promise.all([
    prisma.reservation.findUnique({
      where: { id: confirmation.reservationId },
      include: { property: true },
    }),
    prisma.staffMember.findUnique({
      where: { id: confirmation.staffMemberId },
    }),
  ]);

  if (!reservation || !staff?.phoneE164) {
    return { ok: false, skipped: true, reason: "missing_reservation_or_staff_phone" };
  }

  const timezone = reservation.property?.timezone ?? "America/Puerto_Rico";

  if (!isWithinCleaningMessageHours(timezone, now)) {
    return { ok: false, skipped: true, reason: "outside_allowed_hours" };
  }

  const recentFailed = await prisma.messageDispatchLog.findFirst({
    where: {
      reservationId: confirmation.reservationId,
      type: DISPATCH_TYPE,
      channel: "sms",
      status: "FAILED",
      createdAt: {
        gte: new Date(now.getTime() - FAILED_RETRY_COOLDOWN_MINUTES * 60_000),
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (recentFailed) {
    return { ok: false, skipped: true, reason: "recent_failed_sms" };
  }

  const alreadySentForThisConfirmation = await prisma.messageLog.findFirst({
    where: {
      reservationId: confirmation.reservationId,
      propertyId: confirmation.propertyId,
      to: staff.phoneE164,
      channel: "sms",
      provider: "twilio",
      status: "SENT",
      body: {
        contains: confirmation.token,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (alreadySentForThisConfirmation) {
    return { ok: true, skipped: true, reason: "already_sent_for_confirmation" };
  }

  const confirmUrl = buildConfirmUrl(confirmation.token);

  if (!confirmUrl) {
    console.warn("[CLEANING_CONFIRMATION_DISPATCH] missing API base url", {
      confirmationId: confirmation.id,
      reservationId: confirmation.reservationId,
    });

    return { ok: false, skipped: true, reason: "missing_api_base_url" };
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

  return { ok: true, skipped: false };
}

async function maybeFallbackCleaningConfirmation(params: {
  prisma: PrismaClient;
  confirmation: {
    id: string;
    reservationId: string;
    propertyId: string;
    staffMemberId: string;
    token: string;
    status: string;
    createdAt: Date;
  };
  now: Date;
}) {
  const { prisma, confirmation, now } = params;

  const confirmed = await prisma.cleaningConfirmation.findFirst({
    where: {
      reservationId: confirmation.reservationId,
      status: "CONFIRMED",
    },
  });

  if (confirmed) {
    return { fallbackCreated: false, reason: "already_confirmed" };
  }

  const sentLog = await prisma.messageLog.findFirst({
    where: {
      reservationId: confirmation.reservationId,
      propertyId: confirmation.propertyId,
      channel: "sms",
      provider: "twilio",
      status: "SENT",
      body: {
        contains: confirmation.token,
      },
    },
    orderBy: { createdAt: "asc" },
  });

  if (!sentLog) {
    return { fallbackCreated: false, reason: "sms_not_sent_yet" };
  }

  const expiresAt = new Date(
    sentLog.createdAt.getTime() + FALLBACK_AFTER_MINUTES * 60_000
  );

  if (now < expiresAt) {
    return { fallbackCreated: false, reason: "not_expired_yet" };
  }

  const existingPendingOther = await prisma.cleaningConfirmation.findFirst({
    where: {
      reservationId: confirmation.reservationId,
      status: "PENDING",
      id: { not: confirmation.id },
    },
  });

  if (existingPendingOther) {
    return { fallbackCreated: false, reason: "another_pending_exists" };
  }

  const allAttempts = await prisma.cleaningConfirmation.findMany({
    where: {
      reservationId: confirmation.reservationId,
    },
    select: {
      staffMemberId: true,
    },
  });

  const excludeStaffIds = allAttempts.map((a) => a.staffMemberId);

  const nextStaff = await selectNextStaffForProperty({
    propertyId: confirmation.propertyId,
    excludeStaffIds,
  });

  await prisma.cleaningConfirmation.update({
    where: { id: confirmation.id },
    data: {
      status: "EXPIRED",
    },
  });

  if (!nextStaff) {
    console.warn("[CLEANING_CONFIRMATION_FALLBACK] no backup staff available", {
      reservationId: confirmation.reservationId,
      propertyId: confirmation.propertyId,
      expiredConfirmationId: confirmation.id,
      excludeStaffIds,
    });

    return { fallbackCreated: false, reason: "no_backup_available" };
  }

  const token = crypto.randomBytes(32).toString("hex");

  const nextConfirmation = await prisma.cleaningConfirmation.create({
    data: {
      reservationId: confirmation.reservationId,
      propertyId: confirmation.propertyId,
      staffMemberId: nextStaff.id,
      token,
      status: "PENDING",
    },
  });

  console.log("[CLEANING_CONFIRMATION_FALLBACK] created backup confirmation", {
    reservationId: confirmation.reservationId,
    propertyId: confirmation.propertyId,
    expiredConfirmationId: confirmation.id,
    nextConfirmationId: nextConfirmation.id,
    nextStaffId: nextStaff.id,
  });

  return {
    fallbackCreated: true,
    nextConfirmation,
  };
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
    return {
      processed: 0,
      sent: 0,
      skipped: 0,
      fallbackCreated: 0,
      expired: 0,
    };
  }

  let sentCount = 0;
  let skippedCount = 0;
  let fallbackCreatedCount = 0;
  let expiredCount = 0;

  for (const confirmation of confirmations) {
    try {
      const fallbackResult = await maybeFallbackCleaningConfirmation({
        prisma,
        confirmation,
        now,
      });

      if (fallbackResult.reason === "already_confirmed") {
        skippedCount++;
        continue;
      }

      if (fallbackResult.reason === "no_backup_available") {
        expiredCount++;
        skippedCount++;
        continue;
      }

      if (fallbackResult.fallbackCreated && fallbackResult.nextConfirmation) {
        fallbackCreatedCount++;
        expiredCount++;

        const sent = await sendCleaningConfirmationSms({
          prisma,
          confirmation: fallbackResult.nextConfirmation,
          now,
        });

        if (sent.ok && !sent.skipped) {
          sentCount++;
        } else {
          skippedCount++;
        }

        continue;
      }

      const sent = await sendCleaningConfirmationSms({
        prisma,
        confirmation,
        now,
      });

      if (sent.ok && !sent.skipped) {
        sentCount++;
      } else {
        skippedCount++;
      }
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
    fallbackCreated: fallbackCreatedCount,
    expired: expiredCount,
  };
}