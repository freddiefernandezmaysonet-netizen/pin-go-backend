// src/services/nfc-retry.service.ts
import { prisma as prismaSingleton } from "../lib/prisma";
import { Prisma, PrismaClient, NfcAssignmentStatus } from "@prisma/client";
import { ttlockChangeCardPeriod } from "../ttlock/ttlock.card";

export async function retryNfcAssignments(db?: PrismaClient, now: Date = new Date()) {
  const prisma = db ?? prismaSingleton;

  const batch = await prisma.nfcAssignment.findMany({
    where: {
      status: NfcAssignmentStatus.FAILED,
      lastError: { startsWith: "RETRYABLE:" },
      endsAt: { gt: now },
    },
    include: {
      NfcCard: true,
      Reservation: { select: { lockId: true } }, // ✅ para resolver ttlockLockId
    },
    orderBy: { updatedAt: "asc" },
    take: 25,
  });

  let retried = 0;
  let activated = 0;
  let retired = 0;

  for (const a of batch) {
    retried++;

    // ✅ relación correcta
    if (!a.NfcCard) continue;
    if (a.NfcCard.status === Prisma.NfcCardStatus.RETIRED) continue;

    // ✅ resolver ttlockLockId de forma correcta (Lock -> ttlockLockId)
    const lockId = a.Reservation?.lockId;
    if (!lockId) {
      await prisma.nfcAssignment.update({
        where: { id: a.id },
        data: { lastError: "FATAL: Missing Reservation.lockId for retry" },
      });
      continue;
    }

    const lock = await prisma.lock.findUnique({
      where: { id: lockId },
      select: { ttlockLockId: true },
    });

    const ttlockLockId = lock?.ttlockLockId;
    if (!ttlockLockId) {
      await prisma.nfcAssignment.update({
        where: { id: a.id },
        data: { lastError: "FATAL: Missing Lock.ttlockLockId for retry" },
      });
      continue;
    }

    try {
      await ttlockChangeCardPeriod({
        lockId: Number(ttlockLockId),
        cardId: Number(a.NfcCard.ttlockCardId),
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
      const msg = String(e?.message ?? e).trim().slice(0, 4000);
      const lower = msg.toLowerCase();

      // tarjeta no existe / no está en lock -> retirar del pool
      if (
        lower.includes("ic card does not exist") ||
        lower.includes("card does not exist") ||
        lower.includes("not exist")
      ) {
        await prisma.$transaction([
          prisma.nfcCard.update({
            where: { id: a.nfcCardId },
            data: {
              status: Prisma.NfcCardStatus.RETIRED,
              label: `RETIRED (missing in TTLock) ${a.NfcCard.ttlockCardId}`,
            },
          }),
          prisma.nfcAssignment.update({
            where: { id: a.id },
            data: { status: Prisma.NfcAssignmentStatus.FAILED, lastError: `CARD_MISSING: ${msg}` },
          }),
        ]);

        retired++;
        continue;
      }

      // se queda FAILED pero actualiza lastError para que vuelva a entrar a retry
      await prisma.nfcAssignment.update({
        where: { id: a.id },
        data: { lastError: `RETRYABLE: ${msg}` },
      });
    }
  }

  return { retried, activated, retired };
}