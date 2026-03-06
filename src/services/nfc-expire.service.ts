// src/services/nfc-expire.service.ts
import { prisma as prismaSingleton } from "../lib/prisma";
import {
  PrismaClient,
  NfcAssignmentRole,
  NfcAssignmentStatus,
  NfcCardStatus,
} from "@prisma/client";
import { ttlockChangeCardPeriod } from "../ttlock/ttlock.card";

export async function expireNfcAssignments(db?: PrismaClient, now: Date = new Date()) {
  const prisma = db ?? prismaSingleton;

  const expired = await prisma.nfcAssignment.findMany({
    where: {
      status: NfcAssignmentStatus.ACTIVE,
      endsAt: { lt: now },
    },
    select: { id: true, nfcCardId: true },
    take: 200,
  });

  if (expired.length === 0) return { expired: 0 };

  await prisma.$transaction(async (tx) => {
    await tx.nfcAssignment.updateMany({
      where: { id: { in: expired.map((e) => e.id) } },
      data: { status: NfcAssignmentStatus.ENDED },
    });

    await tx.nfcCard.updateMany({
      where: { id: { in: expired.map((e) => e.nfcCardId) } },
      data: { status: NfcCardStatus.AVAILABLE },
    });
  });

  return { expired: expired.length };
}

export async function expireCleaningNfcAssignments(prisma: PrismaClient, now: Date) {
  const due = await prisma.nfcAssignment.findMany({
    where: {
      role: NfcAssignmentRole.CLEANING,
      status: NfcAssignmentStatus.ACTIVE,
      endsAt: { lte: now },
    },
    include: { NfcCard: true, Reservation: { include: { accessGrants: { include: { lock: true } } } } },
    take: 50,
  });

  let ended = 0;

  for (const a of due) {
    try {
      // lockId TTLock: lo sacamos de cualquier lock del reservation/grant (simple)
      const lockIdTt = a.Reservation?.accessGrants?.[0]?.lock?.ttlockLockId;
      if (lockIdTt && a.NfcCard?.ttlockCardId) {
        const nowMs = now.getTime();
        await ttlockChangeCardPeriod({
          lockId: Number(lockIdTt),
          cardId: Number(a.NfcCard.ttlockCardId),
          startDate: nowMs - 60_000,
          endDate: nowMs - 30_000,
          changeType: 2,
        });
      }

      await prisma.$transaction([
        prisma.nfcAssignment.update({
          where: { id: a.id },
          data: { status: NfcAssignmentStatus.ENDED, lastError: null },
        }),
        prisma.nfcCard.update({
          where: { id: a.nfcCardId },
          data: { status: NfcCardStatus.AVAILABLE },
        }),
      ]);

      ended++;
    } catch (e: any) {
      await prisma.nfcAssignment.update({
        where: { id: a.id },
        data: { lastError: `EXPIRE_FAILED: ${String(e?.message ?? e)}` },
      }).catch(() => {});
    }
  }

  return { count: ended, totalDue: due.length };
}


export async function expireGuestNfcAssignments(prisma: PrismaClient, now: Date) {
  const due = await prisma.nfcAssignment.findMany({
    where: {
      role: NfcAssignmentRole.GUEST,
      status: { in: [NfcAssignmentStatus.ACTIVE, NfcAssignmentStatus.FAILED] },
      // ✅ fuente de verdad: la reserva
      Reservation: { checkOut: { lte: now } },
    },
    include: {
      NfcCard: true,
      Reservation: { include: { accessGrants: { include: { lock: true } } } },
    },
    take: 100,
  });

  let ended = 0;

  for (const a of due) {
    const nowMs = now.getTime();
    let lastError: string | null = null;

    try {
      // busca un lock TTLock desde los grants de esa reserva
      const lockIdTt =
        a.Reservation.accessGrants.find((g: any) => g?.lock?.ttlockLockId)?.lock?.ttlockLockId;

      if (lockIdTt && a.NfcCard?.ttlockCardId) {
        await ttlockChangeCardPeriod({
          lockId: Number(lockIdTt),
          cardId: Number(a.NfcCard.ttlockCardId),
          startDate: nowMs - 60_000,
          endDate: nowMs - 30_000,
          changeType: 2,
        });
      }
    } catch (e: any) {
      // ⚠️ NO rompas el tick; solo registra el error
      lastError = `TTLOCK_EXPIRE_GUEST_FAILED: ${String(e?.message ?? e)}`;
    }

    // ✅ DB SIEMPRE: ENDED + AVAILABLE
    await prisma.$transaction([
      prisma.nfcAssignment.update({
        where: { id: a.id },
        data: { status: NfcAssignmentStatus.ENDED, lastError },
      }),
      prisma.nfcCard.update({
        where: { id: a.nfcCardId },
        data: { status: NfcCardStatus.AVAILABLE },
      }),
    ]);

    ended++;
  }

  return { count: ended, totalDue: due.length };
}

