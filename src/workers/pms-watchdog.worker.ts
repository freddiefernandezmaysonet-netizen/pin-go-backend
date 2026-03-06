import { PrismaClient } from "@prisma/client";
import { reconcileReservation } from "../services/reservation.reconcile.service";

const prisma = new PrismaClient();

const POLL_MS = Number(process.env.PMS_WATCHDOG_POLL_MS ?? 60_000);
const BATCH_SIZE = Number(process.env.PMS_WATCHDOG_BATCH_SIZE ?? 20);
const STALE_MINUTES = Number(process.env.PMS_WATCHDOG_STALE_MINUTES ?? 10);

function log(...args: any[]) {
  console.log("[pms.watchdog]", ...args);
}
function errLog(...args: any[]) {
  console.error("[pms.watchdog]", ...args);
}

async function tick() {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_MINUTES * 60_000);

  const rows = await prisma.reservation.findMany({
    where: {
      OR: [{ lastReconciledAt: null }, { lastReconciledAt: { lt: staleCutoff } }],
    },
    orderBy: { updatedAt: "desc" },
    take: BATCH_SIZE,
    select: { id: true, updatedAt: true, lastReconciledAt: true },
  });

  if (rows.length > 0) log("tick", { found: rows.length });

  for (const r of rows) {
    try {
      await reconcileReservation(r.id);
    } catch (e: any) {
      errLog("reconcile failed", { reservationId: r.id, err: String(e?.message ?? e) });
    }
  }
}

export async function startPmsWatchdog() {
  log(`BOOT poll=${POLL_MS}ms batch=${BATCH_SIZE} staleMin=${STALE_MINUTES}`);
  await tick().catch((e) => errLog("initial tick failed", e));
  setInterval(() => void tick().catch((e) => errLog("tick failed", e)), POLL_MS);
}
