export const CLEANING_TIMING_CONSENT_VERSION = "cleaning_timing_v1";

export type CleaningTimingConsentTerms = Readonly<{
  scheduledStartAt: Date;
  durationCommitmentMinutes: number;
  startConfirmationGraceMinutes: number;
  followupGraceMinutes: number;
}>;

export type CleaningTimingConsentSnapshot = CleaningTimingConsentTerms & Readonly<{
  version: typeof CLEANING_TIMING_CONSENT_VERSION;
  scheduledCompletionAt: Date;
  startConfirmationDueAt: Date;
  followupAttentionAt: Date;
}>;

function requireMinutes(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error("CLEANING_TIMING_CONSENT_INVALID_TIMING");
  }
  return value;
}

export function buildCleaningTimingConsentSnapshot(
  terms: CleaningTimingConsentTerms,
): CleaningTimingConsentSnapshot {
  if (!(terms.scheduledStartAt instanceof Date) || !Number.isFinite(terms.scheduledStartAt.getTime())) {
    throw new Error("CLEANING_TIMING_CONSENT_INVALID_START");
  }
  const duration = requireMinutes(terms.durationCommitmentMinutes, 15, 1440);
  const startGrace = requireMinutes(terms.startConfirmationGraceMinutes, 5, 240);
  const followupGrace = requireMinutes(terms.followupGraceMinutes, 5, 240);
  const minute = 60_000;
  const scheduledCompletionAt = new Date(terms.scheduledStartAt.getTime() + duration * minute);
  return {
    ...terms,
    version: CLEANING_TIMING_CONSENT_VERSION,
    scheduledCompletionAt,
    startConfirmationDueAt: new Date(terms.scheduledStartAt.getTime() + startGrace * minute),
    followupAttentionAt: new Date(scheduledCompletionAt.getTime() + followupGrace * minute),
  };
}

export function timingConsentMatches(
  accepted: Pick<CleaningTimingConsentSnapshot, "version" | "scheduledStartAt" | "durationCommitmentMinutes" | "startConfirmationGraceMinutes" | "followupGraceMinutes">,
  current: CleaningTimingConsentSnapshot,
): boolean {
  return accepted.version === current.version &&
    accepted.scheduledStartAt.getTime() === current.scheduledStartAt.getTime() &&
    accepted.durationCommitmentMinutes === current.durationCommitmentMinutes &&
    accepted.startConfirmationGraceMinutes === current.startConfirmationGraceMinutes &&
    accepted.followupGraceMinutes === current.followupGraceMinutes;
}
