import type { PrismaClient } from "@prisma/client";

export type ConfirmCleaningStartInput = Readonly<{
  workId: string;
  reservationId: string;
  staffMemberId: string;
  confirmationId: string;
}>;

/**
 * Cleaner declaration only. It is not proof of physical entry and does not alter
 * the scheduled start, committed completion, NFC window, or reservation.
 */
export async function confirmCleaningStart(
  prisma: PrismaClient,
  input: ConfirmCleaningStartInput,
  now = new Date(),
) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("CLEANING_START_INVALID_DATE");
  }
  return prisma.$transaction(async tx => {
    // Serialize cleaner declarations with schedule renewal and snapshot creation.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Reservation" WHERE "id" = ${input.reservationId} FOR UPDATE`;
    if (locked.length !== 1) throw new Error("CLEANING_START_RESERVATION_NOT_FOUND");
    const work = await tx.cleaningWork.findFirst({
      where: {
        id: input.workId,
        reservationId: input.reservationId,
        staffMemberId: input.staffMemberId,
        confirmationId: input.confirmationId,
      },
    });
    if (!work) throw new Error("CLEANING_START_WORK_NOT_FOUND");
    if (work.cancelledAt || work.supersededAt || work.completionConfirmedAt) {
      throw new Error("CLEANING_START_WORK_CLOSED");
    }
    if (!work.timingConsentAcceptedAt || !work.timingConsentVersion) {
      throw new Error("CLEANING_START_TIMING_CONSENT_REQUIRED");
    }
    if (work.startConfirmedAt) return work;
    return tx.cleaningWork.update({
      where: { id: work.id },
      data: { startConfirmedAt: now },
    });
  });
}
