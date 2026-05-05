import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
//import { sendSms } from "../lib/sms"; // ya tienes Twilio

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

  if (!staff || !staff.phoneE164) return;

  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { property: true },
  });

  if (!reservation) return;

  const token = crypto.randomBytes(32).toString("hex");

  // guardamos request
  await prisma.cleaningConfirmation.create({
    data: {
      reservationId,
      propertyId,
      staffMemberId,
      token,
      status: "PENDING",
    },
  });

  const confirmUrl = `${process.env.APP_URL}/cleaning/confirm/${token}`;
  console.log("📩 Cleaning confirmation link:");
  console.log(confirmUrl);
  console.log("📞 To:", staff.phoneE164);
   
}