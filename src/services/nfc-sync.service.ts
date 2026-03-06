// src/services/nfc-sync.service.ts
import { prisma as prismaSingleton } from "../lib/prisma";
import { PrismaClient, NfcAssignmentStatus } from "@prisma/client";
import { ttlockChangeCardPeriod } from "../ttlock/ttlock.card";

export async function retryPendingNfcSync(db?: PrismaClient, now: Date = new Date()) {
  const prisma = db ?? prismaSingleton;

  const batch = await prisma.nfcAssignment.findMany({
  where: {
    status: NfcAssignmentStatus.FAILED,
    lastError: { startsWith: "RETRYABLE:" },
  },
  include: {
    NfcCard: true,
    Reservation: true,
  },
  take: 20,
  orderBy: { updatedAt: "asc" },
});

  let retried = 0;
  let activated = 0;

  for (const a of batch) {
    retried++;
    if (a.endsAt <= now) continue;

    const card = (a as any).NfcCard;
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
        data: { status: NfcAssignmentStatus.ACTIVE, lastError: null },
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
