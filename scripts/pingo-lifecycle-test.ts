import axios from "axios";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PROVIDER = process.env.PMS_PROVIDER ?? "GUESTY";

// ✅ pega aquí tu connectionId real o pásalo por env CONNECTION_ID
const CONNECTION_ID = process.env.CONNECTION_ID ?? "PEGA_AQUI_CONNECTION_ID";

// Identificador del test (para poder encontrar la reserva)
const TEST_TAG = "Lifecycle Test " + Date.now();
const TEST_RES_KEY = "LIFE_" + Date.now(); // ✅ mismo id para toda la corrida
function iso(d: Date) {
  return d.toISOString();
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ingestReservation(checkOutOffsetDays: number) {
  const checkIn = new Date(Date.now() - 60_000);
  const checkOut = new Date(Date.now() + checkOutOffsetDays * 86_400_000);

  const body: any = {
    // ⚠️ esto es “normalized” — si tu webhook espera formato Guesty raw, me lo dices y lo adaptamos
    reservationId: TEST_RES_KEY,  
    propertyId: "TEST_PROPERTY",
    ttlockLockId: 25439884,
    checkIn: iso(checkIn),
    checkOut: iso(checkOut),
    guestName: TEST_TAG,
    guestPhone: "+17875550123",
    status: "CONFIRMED",
    externalId: TEST_RES_KEY,
    externalReservationId: TEST_RES_KEY,
    pmsReservationId: TEST_RES_KEY,
    providerReservationId: TEST_RES_KEY,
 };

  const r = await axios.post(`${BASE}/api/ingest/reservations`, {
  provider: PROVIDER,
  connectionId: CONNECTION_ID,
  ...body,
});
  console.log("Ingest result:", r.data);

  return { checkIn, checkOut };
}

async function cancelReservation() {
  const body: any = {
    reservationId: TEST_RES_KEY,

    // ✅ aliases por si tu cancel busca otro campo
    externalId: TEST_RES_KEY,
    externalReservationId: TEST_RES_KEY,
    pmsReservationId: TEST_RES_KEY,
    providerReservationId: TEST_RES_KEY,

    status: "CANCELLED",
  };

  const r = await axios.post(`${BASE}/api/ingest/reservations`, {
  provider: PROVIDER,
  connectionId: CONNECTION_ID,
  ...body,
});
  console.log("Cancel result:", r.data);
}

async function findReservationCreatedRecently(since: Date) {
  // 1) Busca por guestName/tag si existe en tu modelo
  // 2) si no existe guestName, igual te trae la última creada desde "since"
  const r = await prisma.reservation.findFirst({
    where: {
      createdAt: { gte: since },
      // @ts-ignore (por si el campo no existe)
      OR: [{ guestName: TEST_TAG }, { guestName: { contains: "Lifecycle Test" } }],
    } as any,
    orderBy: { createdAt: "desc" },
    include: { accessGrants: true },
  });

  if (r) return r;

  // fallback: última reserva creada
  return prisma.reservation.findFirst({
    orderBy: { createdAt: "desc" },
    include: { accessGrants: true },
  });
}
async function checkReservation(since: Date) {
  const r: any = await prisma.reservation.findFirst({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    include: { accessGrants: true },
  });

  console.log("\nReservation:", r?.id);
  console.log("Status:", r?.status);
  console.log("CheckIn:", r?.checkIn);
  console.log("CheckOut:", r?.checkOut);
  console.log("AccessGrants:", r?.accessGrants?.length);

  return r;
}
async function checkNfc(reservationId?: string) {
  if (!reservationId) {
    console.log("NFC assignments: 0 (no reservationId)");
    return;
  }

  const n = await prisma.nfcAssignment.findMany({
    where: { reservationId },
  });

  console.log("NFC assignments:", n.length);
}

async function run() {
  console.log("\n==============================");
  console.log("PIN&GO LIFECYCLE TEST");
  console.log("==============================\n");

  console.log("BASE:", BASE);
  console.log("PROVIDER:", PROVIDER);
  console.log("CONNECTION_ID:", CONNECTION_ID);
  console.log("SCRIPT DATABASE_URL:", process.env.DATABASE_URL ? "SET" : "NOT SET");

  const since = new Date(Date.now() - 5 * 60_000);

  console.log("\nTEST 1: Initial reservation ingest");
  await ingestReservation(2);
  await sleep(1500);
  const r1 = await checkReservation();

  console.log("\nTEST 2: Idempotency (same payload again)");
  await ingestReservation(2);
  await sleep(1500);
  const r2 = await checkReservation();

  console.log("\nTEST 3: Checkout update (new checkout)");
  await ingestReservation(3);
  await sleep(1500);
  const r3 = await checkReservation();

  console.log("\nTEST 4: NFC assignment");
  await checkNfc(r3?.id ?? r2?.id ?? r1?.id);

  console.log("\nTEST 5: Cancel reservation");
  await cancelReservation();
  await sleep(1500);
  await checkReservation();

  console.log("\n==============================");
  console.log("TEST FINISHED");
  console.log("==============================\n");

  process.exit(0);
}

run().finally(async () => {
  await prisma.$disconnect();
});