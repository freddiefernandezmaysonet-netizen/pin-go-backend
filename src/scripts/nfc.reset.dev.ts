import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { refreshNfcPoolFromTTLock } from "../services/nfc.service";

const prisma = new PrismaClient();

async function main() {
  const propertyId = "cmliac18580001n08sg7l3z9ns";
  const ttlockLockId = 25439884;

  console.log("=== NFC DEV RESET START ===", { propertyId, ttlockLockId });

  // 1) Borrar assignments de esa propiedad (vía relación NfcCard.propertyId)
  const delAssign = await prisma.nfcAssignment.deleteMany({
    where: { NfcCard: { propertyId } },
  });
  console.log("Deleted NfcAssignments:", delAssign.count);

  // 2) Borrar cards de esa propiedad
  const delCards = await prisma.nfcCard.deleteMany({
    where: { propertyId },
  });
  console.log("Deleted NfcCards:", delCards.count);

  // 3) Resync limpio desde TTLock
  const sync = await refreshNfcPoolFromTTLock(prisma, {
    propertyId,
    ttlockLockId,
    // pon tus mínimos si quieres forzar calidad del pool
    minTotals: { guest: 4, cleaning: 2 },
  });

  console.log("Resync done:", sync);
  console.log("=== NFC DEV RESET END ===");
}

main()
  .catch((e) => {
    console.error("DEV RESET FAILED:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });