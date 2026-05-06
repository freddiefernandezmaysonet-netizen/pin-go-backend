import { PrismaClient } from "@prisma/client";
import crypto from "crypto";

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

  console.log("[CLEANING_CONFIRMATION] created pending", {
    reservationId,
    propertyId,
    staffMemberId,
    confirmationId: confirmation.id,
    timezone: reservation.property?.timezone ?? null,
  });

  return confirmation;
}