import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const propertyId = process.argv[2];
  if (!propertyId) throw new Error("Usage: tsx scripts/delete-property.ts <propertyId>");

  // 1) buscar reservas de esa property
  const reservations = await prisma.reservation.findMany({
    where: { propertyId },
    select: { id: true },
  });
  const reservationIds = reservations.map(r => r.id);

  // 2) borrar NFC assignments de esas reservas
  if (reservationIds.length) {
    await prisma.nfcAssignment.deleteMany({
      where: { reservationId: { in: reservationIds } },
    });

    // si tienes accessGrants ligados a reservation:
    await prisma.accessGrant.deleteMany({
      where: { reservationId: { in: reservationIds } },
    });

    // si tienes otras tablas ligadas a reservation, bórralas aquí también
    await prisma.reservation.deleteMany({
      where: { id: { in: reservationIds } },
    });
  }

  // 3) borrar NFC cards y locks de la property
  await prisma.nfcCard.deleteMany({ where: { propertyId } });
  await prisma.lock.deleteMany({ where: { propertyId } });

  // 4) por fin borrar property
  await prisma.property.delete({ where: { id: propertyId } });

  console.log("Deleted property and related data:", { propertyId });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });