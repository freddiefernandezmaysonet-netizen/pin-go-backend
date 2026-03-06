// src/workers/nfc-watchdog.worker.ts
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { healNfcAssignment } from "../services/nfc-autoheal.service";

const prisma = new PrismaClient();

const POLL_MS = Number(process.env.NFC_WATCHDOG_POLL_MS ?? 30_000);
const BATCH_SIZE = Number(process.env.NFC_WATCHDOG_BATCH_SIZE ?? 20);
const STUCK_MINUTES = Number(process.env.NFC_WATCHDOG_STUCK_MINUTES ?? 10);

function log(...args: any[]) {
  console.log("[nfc.watchdog]", ...args);
}
function err(...args: any[]) {
  console.error("[nfc.watchdog]", ...args);
}

async function acquireAssignmentLock(assignmentId: string): Promise<boolean> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS ok`,
    assignmentId
  );
  return Boolean(rows?.[0]?.ok);
}

async function releaseAssignmentLock(assignmentId: string) {
  await prisma.$queryRawUnsafe(
    `SELECT pg_advisory_unlock(hashtext($1)::bigint)`,
    assignmentId
  );
}

async function tick() {
  const now = new Date();
  const stuckBefore = new Date(now.getTime() - STUCK_MINUTES * 60_000);

  const candidates = await prisma.nfcAssignment.findMany({
    where: {
      updatedAt: { lt: stuckBefore },
    },
    orderBy: [{ updatedAt: "asc" }],
    take: BATCH_SIZE,
    include: {
      NfcCard: true,
      Reservation: true,
    },
  });

  log(`tick candidates=${candidates.length}`);

  for (const a of candidates) {
    const got = await acquireAssignmentLock(a.id);
    if (!got) continue;

    try {
      await healNfcAssignment(a.id);
    } catch (e: any) {
      err(`heal failed assignment=${a.id}`, e?.message ?? e);
    } finally {
      await releaseAssignmentLock(a.id);
    }
  }
}

export async function startNfcWatchdog() {
  log(`BOOT poll=${POLL_MS}ms batch=${BATCH_SIZE} stuckMin=${STUCK_MINUTES}`);
  await tick();
  setInterval(() => void tick(), POLL_MS);
}
