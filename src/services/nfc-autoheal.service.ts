// src/services/nfc-autoheal.service.ts
import { NfcAssignmentStatus, NfcCardStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { ttlockChangeCardPeriod } from "../ttlock/ttlock.card";

/**
 * Auto-heal por assignmentId.
 * Repara un NfcAssignment existente usando su misma tarjeta NFC.
 * No crea assignments nuevos.
 */
export async function healNfcAssignment(assignmentId: string) {
  const a = await prisma.nfcAssignment.findUnique({
    where: { id: assignmentId },
    include: {
      NfcCard: true,
      Reservation: true,
    },
  });

  if (!a) return { ok: false, reason: "ASSIGNMENT_NOT_FOUND" };

  if (a.status === NfcAssignmentStatus.ENDED) {
    return { ok: true, skipped: true, reason: "ASSIGNMENT_ENDED" };
  }

  if (!a.NfcCard?.ttlockCardId) {
    throw new Error("NFC_ASSIGNMENT_MISSING_TTLOCK_CARD_ID");
  }

  const propertyId =
    a.NfcCard.propertyId || a.Reservation?.propertyId || null;

  if (!propertyId) {
    throw new Error("NFC_ASSIGNMENT_MISSING_PROPERTY_ID");
  }

 const lock = await prisma.lock.findFirst({
  where: {
    propertyId: assignment.propertyId,
    isActive: true,
  },
  select: {
    id: true,
    ttlockLockId: true,
  },
});

if (!lock?.ttlockLockId) {
  console.warn("[nfc.autoheal] skipped: no active TTLock lock", {
    assignmentId,
    propertyId: assignment.propertyId,
  });
  return {
    ok: false,
    skipped: true,
    reason: "NO_ACTIVE_TTLOCK_LOCK",
  };
}
  await ttlockChangeCardPeriod({
    lockId: Number(lock.ttlockLockId),
    cardId: Number(a.NfcCard.ttlockCardId),
    startDate: a.startsAt.getTime(),
    endDate: a.endsAt.getTime(),
    changeType: 2,
  });

  await prisma.nfcAssignment.update({
    where: { id: a.id },
    data: {
      status: NfcAssignmentStatus.ACTIVE,
      lastError: null,
    },
  });

  await prisma.nfcCard.update({
    where: { id: a.nfcCardId },
    data: {
      status: NfcCardStatus.ASSIGNED,
    },
  });

  return {
    ok: true,
    assignmentId: a.id,
    propertyId,
    lockId: lock.id,
    ttlockLockId: lock.ttlockLockId,
    ttlockCardId: a.NfcCard.ttlockCardId,
  };
}