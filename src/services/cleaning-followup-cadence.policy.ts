export const CLEANING_FOLLOWUP_CLAIM_INTERVAL_MS = 60_000;

export function shouldRunCleaningFollowupClaimCycle(input: Readonly<{
  nowMs: number;
  lastRunAtMs: number | null;
}>): boolean {
  if (!Number.isFinite(input.nowMs)) return false;
  if (input.lastRunAtMs === null) return true;
  if (!Number.isFinite(input.lastRunAtMs)) return false;
  return input.nowMs - input.lastRunAtMs >= CLEANING_FOLLOWUP_CLAIM_INTERVAL_MS;
}
