import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEFAULT_CHECK_IN_TIME = "15:00";

function isValidTime(value: string | null | undefined): value is string {
  return !!value && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function applyLocalTimeFromDate(date: Date, timeStr: string): Date {
  const [hours, minutes] = timeStr.split(":").map(Number);

  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    hours,
    minutes,
    0,
    0
  );
}

async function main() {
  console.log("[backfill] starting...");

  // 1) Backfill Property.checkInTime
  const propertiesMissingCheckIn = await prisma.property.findMany({
    where: {
      OR: [
        { checkInTime: null },
        { checkInTime: "" },
      ],
    },
    select: {
      id: true,
      name: true,
      checkInTime: true,
    },
  });

  console.log("[backfill] properties missing checkInTime:", propertiesMissingCheckIn.length);

  for (const property of propertiesMissingCheckIn) {
    await prisma.property.update({
      where: { id: property.id },
      data: { checkInTime: DEFAULT_CHECK_IN_TIME },
    });

    console.log("[backfill] property updated", {
      propertyId: property.id,
      propertyName: property.name,
      checkInTime: DEFAULT_CHECK_IN_TIME,
    });
  }

  // 2) Recalculate future/active reservations + grants
  const now = new Date();

  const reservations = await prisma.reservation.findMany({
    where: {
      status: "ACTIVE",
      checkOut: {
        gte: now,
      },
    },
    include: {
      property: {
        select: {
          id: true,
          name: true,
          checkInTime: true,
        },
      },
      accessGrants: {
        where: {
          status: {
            in: ["PENDING", "ACTIVE"],
          },
        },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          status: true,
        },
      },
    },
    orderBy: {
      checkIn: "asc",
    },
  });

  console.log("[backfill] future active reservations found:", reservations.length);

  let reservationsUpdated = 0;
  let grantsUpdated = 0;
  let reservationsSkipped = 0;

  for (const reservation of reservations) {
    const propertyCheckInTime = isValidTime(reservation.property?.checkInTime)
      ? reservation.property.checkInTime
      : DEFAULT_CHECK_IN_TIME;

    const correctedCheckIn = applyLocalTimeFromDate(
      reservation.checkIn,
      propertyCheckInTime
    );

    const currentCheckIn = reservation.checkIn;
    const needsReservationUpdate =
      currentCheckIn.getTime() !== correctedCheckIn.getTime();

    if (!needsReservationUpdate) {
      reservationsSkipped++;
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await tx.reservation.update({
        where: { id: reservation.id },
        data: {
          checkIn: correctedCheckIn,
        },
      });

      for (const grant of reservation.accessGrants) {
        if (grant.startsAt.getTime() !== correctedCheckIn.getTime()) {
          await tx.accessGrant.update({
            where: { id: grant.id },
            data: {
              startsAt: correctedCheckIn,
            },
          });
          grantsUpdated++;
        }
      }
    });

    reservationsUpdated++;

    console.log("[backfill] reservation updated", {
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      propertyName: reservation.property?.name,
      oldCheckIn: currentCheckIn.toISOString(),
      newCheckIn: correctedCheckIn.toISOString(),
      propertyCheckInTime,
      grantsTouched: reservation.accessGrants.length,
    });
  }

  console.log("[backfill] done", {
    propertiesUpdated: propertiesMissingCheckIn.length,
    reservationsUpdated,
    reservationsSkipped,
    grantsUpdated,
  });
}

main()
  .catch((err) => {
    console.error("[backfill] failed", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });