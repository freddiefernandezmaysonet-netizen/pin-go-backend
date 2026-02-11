// scripts/create-access-grant.js
import dotenv from "dotenv";
dotenv.config({ override: true });
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function assertEnv() {
  const required = ["ORG_ID"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Faltan env vars: ${missing.join(", ")}`);

  const hasLock = !!process.env.LOCK_ID || !!process.env.TTLOCK_LOCK_ID;
  if (!hasLock) throw new Error("Falta LOCK_ID o TTLOCK_LOCK_ID en .env");

  const hasTarget = !!process.env.PERSON_ID || !!process.env.RESERVATION_ID;
  if (!hasTarget) throw new Error("Falta PERSON_ID o RESERVATION_ID en .env");
}

function parseDateOrThrow(value, name) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha inválida para ${name}: ${value}`);
  return d;
}

async function main() {
  assertEnv();

  const ORG_ID = process.env.ORG_ID;

  // 1) Resolver lock
  let lock = null;

  if (process.env.LOCK_ID) {
    lock = await prisma.lock.findUnique({ where: { id: process.env.LOCK_ID } });
  } else {
    const ttlockLockId = Number(process.env.TTLOCK_LOCK_ID);
    lock = await prisma.lock.findUnique({ where: { ttlockLockId } });
  }

  if (!lock) throw new Error("No encontré el Lock. Verifica LOCK_ID o TTLOCK_LOCK_ID.");

  // 2) Validar que el lock pertenezca a la org (via property -> organization)
  const prop = await prisma.property.findUnique({
    where: { id: lock.propertyId },
    select: { organizationId: true },
  });

  if (!prop || prop.organizationId !== ORG_ID) {
    throw new Error("Ese lock no pertenece a tu ORG_ID (Property.organizationId no coincide).");
  }

  // 3) Fechas: defaults seguros
  const startsAt = process.env.STARTS_AT
    ? parseDateOrThrow(process.env.STARTS_AT, "STARTS_AT")
    : new Date();

  const endsAt = process.env.ENDS_AT
    ? parseDateOrThrow(process.env.ENDS_AT, "ENDS_AT")
    : new Date(Date.now() + 24 * 60 * 60 * 1000); // +24h

  if (endsAt <= startsAt) throw new Error("ENDS_AT debe ser mayor que STARTS_AT.");

  // 4) Target: person o reservation
  const personId = process.env.PERSON_ID || null;
  const reservationId = process.env.RESERVATION_ID || null;

  // 5) Crear AccessGrant (DB-only, sin TTLock todavía)
  // method:
  // - PASSCODE_TIMEBOUND => luego lo convertimos en passcode TTLock
  // - AUTHORIZED_ADMIN => luego lo convertimos en eKey/admin share
  const method = process.env.METHOD || "PASSCODE_TIMEBOUND";

  const grant = await prisma.accessGrant.create({
    data: {
      lockId: lock.id,
      personId,
      reservationId,

      method,
      status: "PENDING",

      startsAt,
      endsAt,

      // campos opcionales
      unlockKey: "#",
      accessCodeMasked: null,

      ttlockKeyboardPwdId: null,
      ttlockKeyId: null,
      ttlockPayload: null,

      linkedStripeEventId: null,
      linkedStripeCustomerId: null,
      linkedStripeSubscriptionId: null,

      lastError: null,
    },
  });

  console.log("✅ AccessGrant creado (DB):");
  console.log({
    accessGrantId: grant.id,
    lockId: lock.id,
    ttlockLockId: lock.ttlockLockId,
    method: grant.method,
    status: grant.status,
    startsAt: grant.startsAt,
    endsAt: grant.endsAt,
    personId: grant.personId,
    reservationId: grant.reservationId,
  });

  console.log("\n📌 Próximo paso: provisionarlo en TTLock (crear passcode/ekey real) y actualizar:");
  console.log("- ttlockKeyboardPwdId o ttlockKeyId");
  console.log("- status: ACTIVE");
}

main()
  .catch((e) => {
    console.error("❌ create-access-grant error:", e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
