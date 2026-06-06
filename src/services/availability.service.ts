import { PrismaClient, ReservationStatus } from "@prisma/client";

const prisma = new PrismaClient();

function toDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function eachNightDateKeys(checkIn: Date, checkOut: Date) {
  const dates: string[] = [];

  let cursor = new Date(Date.UTC(
    checkIn.getUTCFullYear(),
    checkIn.getUTCMonth(),
    checkIn.getUTCDate()
  ));

  const end = new Date(Date.UTC(
    checkOut.getUTCFullYear(),
    checkOut.getUTCMonth(),
    checkOut.getUTCDate()
  ));

  while (cursor < end) {
    dates.push(toDateKey(cursor));
    cursor = addDays(cursor, 1);
  }

  return dates;
}

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

export async function getPropertyBlockedDateKeys(input: {
  propertyId: string;
  from: Date;
  to: Date;
}) {
  const { propertyId, from, to } = input;

  if (!propertyId) {
    throw new Error("propertyId is required");
  }

  if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
    throw new Error("Invalid from");
  }

  if (!(to instanceof Date) || Number.isNaN(to.getTime())) {
    throw new Error("Invalid to");
  }

  if (to <= from) {
    throw new Error("to must be after from");
  }

  const reservations = await prisma.reservation.findMany({
    where: {
      propertyId,
      status: ReservationStatus.ACTIVE,
      checkIn: {
        lt: to,
      },
      checkOut: {
        gt: from,
      },
    },
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      status: true,
    },
    orderBy: {
      checkIn: "asc",
    },
  });

  const blockedDateKeys = new Set<string>();

  for (const reservation of reservations) {
    for (const dateKey of eachNightDateKeys(reservation.checkIn, reservation.checkOut)) {
      blockedDateKeys.add(dateKey);
    }
  }

  return {
    blockedDates: Array.from(blockedDateKeys).sort(),
    reservations,
  };
}