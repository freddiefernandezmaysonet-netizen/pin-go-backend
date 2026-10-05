/** Access allowance only. Staff work commitments belong to stay-time eligibility. */
export function planCleanerAccessWindow(input: {
  checkOut: Date;
  property: {
    cleaningDurationMinutes: number;
    cleaningStartOffsetMinutes: number;
  };
  nextCheckIn: Date | null;
}) {
  const p = input.property;
  if (
    !Number.isFinite(input.checkOut.getTime()) ||
    !Number.isSafeInteger(p.cleaningStartOffsetMinutes) ||
    p.cleaningStartOffsetMinutes < 0 ||
    p.cleaningStartOffsetMinutes > 1440 ||
    !Number.isSafeInteger(p.cleaningDurationMinutes) ||
    p.cleaningDurationMinutes <= 0 ||
    p.cleaningDurationMinutes > 1440
  ) {
    throw new Error("CLEANER_ACCESS_TIMING_INVALID");
  }

  const startsAt = new Date(
    input.checkOut.getTime() + p.cleaningStartOffsetMinutes * 60_000
  );
  const desiredEndsAt = new Date(
    startsAt.getTime() + p.cleaningDurationMinutes * 60_000
  );
  const nextMs = input.nextCheckIn?.getTime() ?? Infinity;

  if (Number.isNaN(nextMs)) {
    throw new Error("CLEANER_ACCESS_TIMING_INVALID");
  }

  const endsAt = new Date(Math.min(desiredEndsAt.getTime(), nextMs));
  if (endsAt <= startsAt) {
    throw new Error("CLEANER_ACCESS_WINDOW_EMPTY");
  }

  return {
    startsAt,
    endsAt,
    durationMinutes: p.cleaningDurationMinutes,
  };
}
