import { PrismaClient, ReservationStatus } from "@prisma/client";

const prisma = new PrismaClient();

export async function checkPropertyAvailability(input: {
  propertyId: string;
  checkIn: Date;
  checkOut: Date;
}) {
  const { propertyId, checkIn, checkOut } = input;

  if (!propertyId) {
    throw new Error("propertyId is required");
  }

  if (!(checkIn instanceof Date) || Number.isNaN(checkIn.getTime())) {
    throw new Error("Invalid checkIn");
  }

  if (!(checkOut instanceof Date) || Number.isNaN(checkOut.getTime())) {
    throw new Error("Invalid checkOut");
  }

  if (checkOut <= checkIn) {
    throw new Error("checkOut must be after checkIn");
  }

  const conflict = await prisma.reservation.findFirst({
    where: {
      propertyId,
      status: ReservationStatus.ACTIVE,
      checkIn: {
        lt: checkOut,
      },
      checkOut: {
        gt: checkIn,
      },
    },
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      status: true,
    },
  });

  return {
    available: !conflict,
    conflict,
  };
}