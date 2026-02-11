import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const orgId = process.env.ORG_ID;

  if (!orgId) {
    throw new Error("ORG_ID no está definido en .env");
  }

  const property = await prisma.property.create({
    data: {
      organizationId: orgId,
      name: "Serena Studio at Palmas Del Mar",
      address1: "Palmas del Mar",
      city: "Humacao",
      region: "PR",
      country: "US",
      timezone: "America/Puerto_Rico",
    },
  });

  console.log("✅ Property creada:", property.id);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
