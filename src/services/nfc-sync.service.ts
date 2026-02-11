// src/services/nfc-sync.service.ts
import { prisma as prismaSingleton } from "../lib/prisma";
import { Prisma, PrismaClient } from "@prisma/client";
import { ttlockChangeCardPeriod } from "../ttlock/ttlock.card";

export async function retryPendingNfcSync(db?: PrismaClient, now: Date = new Date()) {
  const prisma = db ?? prismaSingleton;

  const batch = await prisma.nfcAssignment.findMany({
    where: {
      status: Prisma.NfcAssignmentStatus.FAILED,
      lastError: { startsWith: "RETRYABLE:" },
    },
    include: { nfcCard: true },
    take: 20,
    orderBy: { updatedAt: "asc" },
  });

  let retried = 0;
  let activated = 0;

  for (const a of batch) {
    retried++;
    if (a.endsAt <= now) continue;

    const card = (a as any).nfcCard;
    if (!card) continue;

    try {
      await ttlockChangeCardPeriod({
        lockId: Number(card.ttlockLockId ?? card.lockId ?? a.ttlockLockId ?? 0),
        cardId: Number(card.ttlockCardId),
        startDate: a.startsAt.getTime(),
        endDate: a.endsAt.getTime(),
        changeType: 2,
      });

      await prisma.nfcAssignment.update({
        where: { id: a.id },
        data: { status: Prisma.NfcAssignmentStatus.ACTIVE, lastError: null },
      });

      activated++;
    } catch (e: any) {
      await prisma.nfcAssignment.update({
        where: { id: a.id },
        data: { lastError: `RETRYABLE: ${String(e?.message ?? e)}` },
      });
    }
  }

  return { retried, activated };
}
