import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { dedupeNfcCards } from "../src/services/nfc.service";

const prisma = new PrismaClient();

async function main() {
  const propertyId = process.argv[2];
  if (!propertyId) throw new Error("Usage: npx tsx scripts/dedupe-nfc.ts <propertyId>");
  const r = await dedupeNfcCards(prisma, propertyId);
  console.log(r);
}

main().finally(async () => prisma.$disconnect());