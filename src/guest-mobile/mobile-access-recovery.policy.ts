export const MOBILE_ACCESS_RECOVERY_MAX_ATTEMPTS = 8;

const BACKOFF_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

export function nextMobileAccessRecovery(
  attemptCount: number,
  now = new Date(),
) {
  const nextAttemptCount = attemptCount + 1;
  if (nextAttemptCount >= MOBILE_ACCESS_RECOVERY_MAX_ATTEMPTS) {
    return {
      attemptCount: nextAttemptCount,
      lastAttemptAt: now,
      nextAttemptAt: null,
      exhaustedAt: now,
    };
  }
  const delay = BACKOFF_MS[Math.min(nextAttemptCount - 1, BACKOFF_MS.length - 1)]!;
  return {
    attemptCount: nextAttemptCount,
    lastAttemptAt: now,
    nextAttemptAt: new Date(now.getTime() + delay),
    exhaustedAt: null,
  };
}
