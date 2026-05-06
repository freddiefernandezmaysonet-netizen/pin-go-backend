import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
// import { sendSms } from "../lib/sms"; // lo conectamos luego cuando confirmemos firma exacta

const prisma = new PrismaClient();

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

  const timezone =
    reservation.property?.timezone ??
    "America/Puerto_Rico";

  const propertyName =
    reservation.property?.name ??
    reservation.roomName ??
    "la propiedad asignada";

  const checkOutText = reservation.checkOut.toLocaleString("en-US", {
    timeZone: timezone,
  });

  console.log("📩 Cleaning confirmation link:");
  console.log(confirmUrl);
  console.log("📞 To:", staff.phoneE164);
  console.log("[CLEANING_CONFIRMATION] created", {
    reservationId,
    propertyId,
    staffMemberId,
    confirmationId: confirmation.id,
    propertyName,
    checkOut: checkOutText,
    timezone,
  });

  return confirmation;
}