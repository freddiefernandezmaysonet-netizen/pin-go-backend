import type { PrismaClient } from "@prisma/client";

export type ConfirmCleaningCompletionInput = Readonly<{
  workId: string;
  reservationId: string;
  staffMemberId: string;
  confirmationId: string;
}>;

/**
 * Cleaner completion declaration only. It does not prove inspection, alter NFC,
 * or independently declare the property ready for the next guest.
 */
export async function confirmCleaningCompletion(
  prisma: PrismaClient,
  input: ConfirmCleaningCompletionInput,
  now = new Date(),
) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("CLEANING_COMPLETION_INVALID_DATE");
  }
  return prisma.$transaction(async tx => {
    // Serialize cleaner declarations with schedule renewal and snapshot creation.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Reservation" WHERE "id" = ${input.reservationId} FOR UPDATE`;
    if (locked.length !== 1) throw new Error("CLEANING_COMPLETION_RESERVATION_NOT_FOUND");
    const work = await tx.cleaningWork.findFirst({
      where: {
        id: input.workId,
        reservationId: input.reservationId,
        staffMemberId: input.staffMemberId,
        confirmationId: input.confirmationId,
      },
    });
    if (!work) throw new Error("CLEANING_COMPLETION_WORK_NOT_FOUND");
    if (work.cancelledAt || work.supersededAt) {
      throw new Error("CLEANING_COMPLETION_WORK_CLOSED");
    }
    if (!work.timingConsentAcceptedAt || !work.timingConsentVersion) {
      throw new Error("CLEANING_COMPLETION_TIMING_CONSENT_REQUIRED");
    }
    if (!work.startConfirmedAt) {
      throw new Error("CLEANING_COMPLETION_START_REQUIRED");
    }
    if (work.completionConfirmedAt) return work;
    return tx.cleaningWork.update({
      where: { id: work.id },
      data: { completionConfirmedAt: now },
    });
  });
}
