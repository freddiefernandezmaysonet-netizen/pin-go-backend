// prisma/seed.js
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ✅ deleteMany seguro: si el modelo no existe en Prisma Client, lo brinca
async function safeDelete(modelName) {
  const model = prisma[modelName];
  if (!model || typeof model.deleteMany !== "function") {
    console.log(`⚠️ Skip deleteMany: prisma.${modelName} no existe en el client`);
    return;
  }
  await model.deleteMany();
  console.log(`🧹 deleteMany OK: ${modelName}`);
}

async function resetDb() {
  // Orden: de hijos -> padres (evita FK errors)
  await safeDelete("messageLog");
  await safeDelete("accessGrant");
  await safeDelete("managerAssignment");
  await safeDelete("lockGroupLock");
  await safeDelete("lockGroup");
  await safeDelete("stripeEventLog");
  await safeDelete("subscription");
  await safeDelete("reservation");
  await safeDelete("lock");
  await safeDelete("property");
  await safeDelete("tTLockAuth");
  await safeDelete("primeNotifyState");
  await safeDelete("person");
  await safeDelete("organization");
}

async function main() {
  console.log("✅ Prisma Client models:", Object.keys(prisma).filter(k => !k.startsWith("$")));

  // 1) Reset limpio (sin romperse si falta un modelo)
  await resetDb();

  // 2) Crear Organization
  const org = await prisma.organization.create({
    data: { name: "Pin&Go Demo Org" },
  });
  console.log("🏢 Organización creada:", org.id);

  // 3) Crear Person (ADMIN/MANAGER) - tu schema usa PersonRole: MANAGER | GUEST | STAFF
  const admin = await prisma.person.create({
    data: {
      organizationId: org.id,
      role: "MANAGER",              // ✅ NO "ADMIN"
      fullName: "Freddie Fernandez",
      email: "admin@pin-go.local",
      phone: "+17870000000",
      stripeCustomerId: "cus_demo_0001",
    },
  });
  console.log("👤 Admin creado:", admin.id);

  console.log("✅ Seed completado sin errores");
}

main()
  .catch((e) => {
    console.error("❌ Seed falló:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
