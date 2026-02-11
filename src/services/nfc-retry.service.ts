// src/services/nfc-retry.service.ts
import { prisma as prismaSingleton } from "../lib/prisma";
import { Prisma, PrismaClient } from "@prisma/client";
import { ttlockChangeCardPeriod } from "../ttlock/ttlock.card";

export async function retryNfcAssignments(db?: PrismaClient, now: Date = new Date()) {
  const prisma = db ?? prismaSingleton;

  const batch = await prisma.nfcAssignment.findMany({
    where: {
      status: Prisma.NfcAssignmentStatus.FAILED,
      lastError: { startsWith: "RETRYABLE:" },
      endsAt: { gt: now },
    },
    include: { nfcCard: true },
    orderBy: { updatedAt: "asc" },
    take: 25,
  });

  let retried = 0;
  let activated = 0;
  let retired = 0;

  for (const a of batch) {
    retried++;

    if (!a.nfcCard) continue;
    if (a.nfcCard.status === Prisma.NfcCardStatus.RETIRED) continue;

    try {
      await ttlockChangeCardPeriod({
        lockId: Number((a.nfcCard as any).ttlockLockId ?? (a as any).ttlockLockId ?? 0),
        cardId: Number(a.nfcCard.ttlockCardId),
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
      const msg = String(e?.message ?? e);
      const lower = msg.toLowerCase();

      if (lower.includes("ic card does not exist") || lower.includes("card does not exist")) {
        await prisma.nfcCard.update({
          where: { id: a.nfcCardId },
          data: {
            status: Prisma.NfcCardStatus.RETIRED,
            label: `RETIRED (missing in TTLock) ${a.nfcCard.ttlockCardId}`,
          },
        });

        await prisma.nfcAssignment.update({
          where: { id: a.id },
          data: { status: Prisma.NfcAssignmentStatus.FAILED, lastError: `CARD_MISSING: ${msg}` },
        });

        retired++;
        continue;
      }

      await prisma.nfcAssignment.update({
        where: { id: a.id },
        data: { lastError: `RETRYABLE: ${msg}` },
      });
    }
  }

  return { retried, activated, retired };
}
