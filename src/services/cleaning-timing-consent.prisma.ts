import type { PrismaClient } from "@prisma/client";
import { CLEANING_TIMING_CONSENT_VERSION } from "./cleaning-timing-consent.js";

export type AcceptCleaningTimingConsentInput = Readonly<{
  workId: string;
  reservationId: string;
  staffMemberId: string;
  confirmationId: string;
}>;

export async function acceptCleaningTimingConsent(
  prisma: PrismaClient,
  input: AcceptCleaningTimingConsentInput,
  now = new Date(),
) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("CLEANING_TIMING_CONSENT_INVALID_DATE");
  }
  return prisma.$transaction(async tx => {
    const work = await tx.cleaningWork.findFirst({
      where: {
        id: input.workId,
        reservationId: input.reservationId,
        staffMemberId: input.staffMemberId,
        confirmationId: input.confirmationId,
      },
    });
    if (!work) throw new Error("CLEANING_TIMING_CONSENT_WORK_NOT_FOUND");
    if (work.cancelledAt || work.supersededAt || work.completionConfirmedAt) {
      throw new Error("CLEANING_TIMING_CONSENT_WORK_CLOSED");
    }
    if (work.timingConsentAcceptedAt) {
      if (work.timingConsentVersion !== CLEANING_TIMING_CONSENT_VERSION) {
        throw new Error("CLEANING_TIMING_CONSENT_VERSION_CONFLICT");
      }
      return work;
    }
    return tx.cleaningWork.update({
      where: { id: work.id },
      data: {
        timingConsentVersion: CLEANING_TIMING_CONSENT_VERSION,
        timingConsentAcceptedAt: now,
      },
    });
  });
}
