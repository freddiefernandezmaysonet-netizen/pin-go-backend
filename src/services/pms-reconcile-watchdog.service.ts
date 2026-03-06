import type { PrismaClient } from "@prisma/client";
import { reconcileReservation } from "./reservation.reconcile.service";

const STALE_MINUTES = Number(process.env.PMS_WATCHDOG_STALE_MINUTES ?? 10);
const BATCH_SIZE = Number(process.env.PMS_WATCHDOG_BATCH_SIZE ?? 20);

export async function runPmsReconcileBatch(prisma: PrismaClient, now: Date) {
  const staleCutoff = new Date(now.getTime() - STALE_MINUTES * 60_000);

  const rows = await prisma.reservation.findMany({
    where: {
      OR: [{ lastReconciledAt: null }, { lastReconciledAt: { lt: staleCutoff } }],
    },
    orderBy: { updatedAt: "desc" },
    take: BATCH_SIZE,
    select: { id: true },
  });

  let reconciled = 0;

  for (const r of rows) {
    await reconcileReservation(r.id);
    reconciled++;
  }

  return { reconciled, checked: rows.length, staleMin: STALE_MINUTES };
}