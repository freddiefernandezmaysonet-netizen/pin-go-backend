import { prisma } from "../../lib/prisma.js";

async function main(): Promise<void> {
  if (process.env.PIN_AI_RUNTIME_SHADOW_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_SHADOW_DISABLED");
  }
  if (process.env.PIN_AI_RUNTIME_REAL_READ_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_REAL_READ_DISABLED");
  }

  const reservation = await prisma.reservation.findFirst({
    where: {
      status: "ACTIVE",
      property: { status: "ACTIVE" },
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      propertyId: true,
      property: {
        select: {
          name: true,
          city: true,
          region: true,
          country: true,
          timezone: true,
          address1: true,
          latitude: true,
          longitude: true,
        },
      },
    },
  });
  if (!reservation) {
    throw new Error("PIN_AI_RUNTIME_STAGING_ACTIVE_RESERVATION_NOT_FOUND");
  }

  console.log(
    JSON.stringify({
      runtime: "pin-ai-v1",
      mode: "SHADOW_LOCATION_READ_ONLY_AUDIT",
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      propertyName: reservation.property.name,
      city: reservation.property.city,
      region: reservation.property.region,
      country: reservation.property.country,
      timezone: reservation.property.timezone,
      addressPopulated: Boolean(reservation.property.address1?.trim()),
      latitudePopulated: reservation.property.latitude !== null,
      longitudePopulated: reservation.property.longitude !== null,
      databaseWrites: false,
      openAICalls: 0,
      externalCalls: 0,
    }),
  );

  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(`PIN_AI_RUNTIME_LOCATION_AUDIT_FAILED:${message}`);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
