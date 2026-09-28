import type { PrismaClient } from "@prisma/client";
import type { CleaningFollowupCycleRepository } from "./cleaning-followup-cycle.service.js";

export function createCleaningFollowupCycleRepository(
  prisma: Pick<PrismaClient, "cleaningWork">,
): CleaningFollowupCycleRepository {
  return {
    findCandidates(now) {
      return prisma.cleaningWork.findMany({
        where: {
          timingConsentAcceptedAt: { not: null },
          cancelledAt: null,
          supersededAt: null,
          completionConfirmedAt: null,
          scheduledStartAt: { lte: now },
        },
        select: {
          id: true,
          scheduledStartAt: true,
          durationCommitmentMinutes: true,
          startConfirmationGraceMinutes: true,
          followupGraceMinutes: true,
          timingConsentAcceptedAt: true,
          startConfirmedAt: true,
          completionConfirmedAt: true,
          cancelledAt: true,
          supersededAt: true,
        },
        orderBy: { scheduledStartAt: "asc" },
        take: 100,
      });
    },
  };
}
