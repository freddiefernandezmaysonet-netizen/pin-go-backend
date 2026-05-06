import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import { sendSms } from "../integrations/twilio/twilio.client";

const prisma = new PrismaClient();

const DISPATCH_TYPE = "CLEANING_CONFIRMATION";

export async function createCleaningConfirmation(params: {
  reservationId: string;
  propertyId: string;
  staffMemberId: string;
}) {
  const { reservationId, propertyId, staffMemberId } = params;

  const staff = await prisma.staffMember.findUnique({
    where: { id: staffMemberId },
  });

  if (!staff || !staff.phoneE164) {
    console.warn("[CLEANING_CONFIRMATION] skipped: staff missing phone", {
      reservationId,
      propertyId,
      staffMemberId,
    });
    return null;
  }

  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: {
      property: true,
    },
  });

  if (!reservation) {
    console.warn("[CLEANING_CONFIRMATION] skipped: reservation not found", {
      reservationId,
      propertyId,
      staffMemberId,
    });
    return null;
  }

  const existing = await prisma.cleaningConfirmation.findFirst({
    where: {
      reservationId,
      propertyId,
      staffMemberId,
      status: "PENDING",
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existing) {
    console.log("[CLEANING_CONFIRMATION] pending already exists", {
      reservationId,
      propertyId,
      staffMemberId,
      confirmationId: existing.id,
    });

    return existing;
  }

  const existingSent = await prisma.messageDispatchLog.findFirst({
    where: {
      reservationId,
      type: DISPATCH_TYPE,
      channel: "sms",
      status: "SENT",
    },
  });

  if (existingSent) {
    console.log("[CLEANING_CONFIRMATION] sms already sent for reservation", {
      reservationId,
      propertyId,
      staffMemberId,
    });
    return null;
  }

  const token = crypto.randomBytes(32).toString("hex");

  const confirmation = await prisma.cleaningConfirmation.create({
    data: {
      reservationId,
      propertyId,
      staffMemberId,
      token,
      status: "PENDING",
    },
  });

  const rawBaseUrl =
    process.env.API_BASE_URL ??
    process.env.PUBLIC_API_BASE_URL ??
    process.env.APP_URL;

  if (!rawBaseUrl) {
    console.warn("[CLEANING_CONFIRMATION] missing API_BASE_URL/PUBLIC_API_BASE_URL/APP_URL", {
      reservationId,
      propertyId,
      staffMemberId,
      confirmationId: confirmation.id,
    });

    return confirmation;
  }

  const baseUrl = rawBaseUrl.replace(/\/$/, "");
  const confirmUrl = `${baseUrl}/cleaning/confirm/${token}`;

  const timezone = reservation.property?.timezone ?? "America/Puerto_Rico";

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

  try {
    const sent = await sendSms(staff.phoneE164, body);

    await prisma.messageLog.create({
      data: {
        channel: "sms",
        to: staff.phoneE164,
        from: process.env.TWILIO_FROM_NUMBER ?? null,
        body,
        provider: "twilio",
        providerMessageId: (sent as any)?.sid ?? null,
        status: "SENT",
        reservationId,
        propertyId,
        organizationId: reservation.property?.organizationId ?? null,
      },
    });

    await prisma.messageDispatchLog.create({
      data: {
        reservationId,
        type: DISPATCH_TYPE,
        channel: "sms",
        status: "SENT",
      },
    });

    console.log("[CLEANING_CONFIRMATION] sms sent", {
      reservationId,
      propertyId,
      staffMemberId,
      confirmationId: confirmation.id,
      to: staff.phoneE164,
      timezone,
    });
  } catch (e: any) {
    console.error("[CLEANING_CONFIRMATION] sms failed", e);

    await prisma.messageLog.create({
      data: {
        channel: "sms",
        to: staff.phoneE164,
        from: process.env.TWILIO_FROM_NUMBER ?? null,
        body,
        provider: "twilio",
        providerMessageId: null,
        status: "FAILED",
        error: e?.message ?? "unknown_error",
        reservationId,
        propertyId,
        organizationId: reservation.property?.organizationId ?? null,
      },
    }).catch(() => {});

    await prisma.messageDispatchLog.create({
      data: {
        reservationId,
        type: DISPATCH_TYPE,
        channel: "sms",
        status: "FAILED",
      },
    }).catch(() => {});
  }

  return confirmation;
}