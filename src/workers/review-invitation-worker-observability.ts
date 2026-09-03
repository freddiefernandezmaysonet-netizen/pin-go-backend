export type ReviewInvitationDispatchSummary = {
  outcome: "IDLE" | "COMPLETED" | "COMPLETED_WITH_FAILURES";
  candidateCount: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  durationMs: number;
};

type ReviewInvitationDispatchResult = Readonly<{
  status: string;
}>;

type ReviewInvitationDispatchLogger = {
  log: (event: string, metadata: ReviewInvitationDispatchSummary) => void;
  error: (event: string, metadata: ReviewInvitationDispatchSummary) => void;
};

function normalizedDurationMs(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 0;
  return Math.floor(durationMs);
}

export function buildReviewInvitationDispatchSummary(
  results: readonly ReviewInvitationDispatchResult[],
  durationMs: number
): ReviewInvitationDispatchSummary {
  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const result of results) {
    if (result.status === "SENT") sentCount += 1;
    else if (result.status === "SKIPPED") skippedCount += 1;
    else failedCount += 1;
  }

  return {
    outcome:
      results.length === 0
        ? "IDLE"
        : failedCount > 0
          ? "COMPLETED_WITH_FAILURES"
          : "COMPLETED",
    candidateCount: results.length,
    sentCount,
    failedCount,
    skippedCount,
    durationMs: normalizedDurationMs(durationMs),
  };
}

export function emitReviewInvitationDispatchSummary(
  logger: ReviewInvitationDispatchLogger,
  results: readonly ReviewInvitationDispatchResult[],
  durationMs: number
): ReviewInvitationDispatchSummary {
  const summary = buildReviewInvitationDispatchSummary(results, durationMs);

  if (summary.failedCount > 0) {
    logger.error("[REVIEW_INVITATION_DISPATCH_SUMMARY]", summary);
  } else {
    logger.log("[REVIEW_INVITATION_DISPATCH_SUMMARY]", summary);
  }

  return summary;
}
