import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.$queryRawUnsafe(`
    SELECT
      "organizationId",
      "provider",
      "externalId",
      COUNT(*) as total
    FROM "PropertyDevice"
    WHERE "externalId" IS NOT NULL
    GROUP BY "organizationId", "provider", "externalId"
    HAVING COUNT(*) > 1;
  `);

  console.log("DUPLICATES:", result);
}

main().finally(() => prisma.$disconnect());