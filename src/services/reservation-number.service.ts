import type { Prisma, PrismaClient } from "@prisma/client";

type ReservationNumberDb = PrismaClient | Prisma.TransactionClient;

function getReservationNumberScope(date: Date) {
  const year = date.getUTCFullYear();
  return `PG-${year}`;
}

function formatReservationNumber(scope: string, sequence: number) {
  return `${scope}-${String(sequence).padStart(6, "0")}`;
}

export async function generateReservationNumber(
  db: ReservationNumberDb,
  date: Date = new Date()
) {
  const scope = getReservationNumberScope(date);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const counter = await db.reservationNumberCounter.upsert({
      where: {
        scope,
      },
      create: {
        scope,
        nextValue: 2,
      },
      update: {
        nextValue: {
          increment: 1,
        },
      },
      select: {
        nextValue: true,
      },
    });

    const sequence = counter.nextValue - 1;
    const reservationNumber = formatReservationNumber(scope, sequence);

    const existingReservation = await db.reservation.findUnique({
      where: {
        reservationNumber,
      },
      select: {
        id: true,
      },
    });

    if (!existingReservation) {
      return reservationNumber;
    }
  }

  throw new Error(
    `Unable to generate a unique reservation number for scope ${scope}`
  );
}