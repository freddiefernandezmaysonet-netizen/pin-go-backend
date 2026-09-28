import type { CleaningWork } from "@prisma/client";
import { evaluateCleaningFollowup } from "./cleaning-followup.policy.js";
import { claimCleaningFollowupDue, followupDueForDecision } from "./cleaning-followup-receipt.service.js";
import type { CleaningFollowupReceiptStore } from "./cleaning-followup-receipt.service.js";

export type CleaningFollowupCycleWork = Pick<CleaningWork,
  "id" | "scheduledStartAt" | "durationCommitmentMinutes" |
  "startConfirmationGraceMinutes" | "followupGraceMinutes" |
  "timingConsentAcceptedAt" | "startConfirmedAt" | "completionConfirmedAt" |
  "cancelledAt" | "supersededAt">;

export interface CleaningFollowupCycleRepository {
  findCandidates(now: Date): Promise<CleaningFollowupCycleWork[]>;
}

export async function runCleaningFollowupClaimCycle(input: Readonly<{
  repository: CleaningFollowupCycleRepository;
  receipts: CleaningFollowupReceiptStore;
  now: Date;
}>) {
  const works = await input.repository.findCandidates(input.now);
  const results: Array<{ cleaningWorkId: string; decision: string; claim: string }> = [];
  for (const work of works) {
    if (!work.timingConsentAcceptedAt || work.cancelledAt || work.supersededAt) continue;
    const evaluated = evaluateCleaningFollowup({
      scheduledStartAt: work.scheduledStartAt,
      durationMinutes: work.durationCommitmentMinutes,
      startConfirmationGraceMinutes: work.startConfirmationGraceMinutes,
      followupGraceMinutes: work.followupGraceMinutes,
      startConfirmedAt: work.startConfirmedAt,
      completionConfirmedAt: work.completionConfirmedAt,
      cancelled: false,
    }, input.now);
    const due = followupDueForDecision(evaluated);
    const claim = await claimCleaningFollowupDue(input.receipts, work.id, due);
    results.push({ cleaningWorkId: work.id, decision: evaluated.decision, claim });
  }
  return results;
}
