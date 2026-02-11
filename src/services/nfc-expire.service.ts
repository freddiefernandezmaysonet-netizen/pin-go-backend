// src/services/nfc-expire.service.ts
import { prisma as prismaSingleton } from "../lib/prisma";
import { Prisma, PrismaClient } from "@prisma/client";

export async function expireNfcAssignments(db?: PrismaClient, now: Date = new Date()) {
  const prisma = db ?? prismaSingleton;

  const expired = await prisma.nfcAssignment.findMany({
    where: {
      status: Prisma.NfcAssignmentStatus.ACTIVE,
      endsAt: { lt: now },
    },
    select: { id: true, nfcCardId: true },
    take: 200,
  });

  if (expired.length === 0) return { expired: 0 };

  await prisma.$transaction(async (tx) => {
    await tx.nfcAssignment.updateMany({
      where: { id: { in: expired.map((e) => e.id) } },
      data: { status: Prisma.NfcAssignmentStatus.ENDED },
    });

    await tx.nfcCard.updateMany({
      where: { id: { in: expired.map((e) => e.nfcCardId) } },
      data: { status: Prisma.NfcCardStatus.AVAILABLE },
    });
  });

  return { expired: expired.length };
}
