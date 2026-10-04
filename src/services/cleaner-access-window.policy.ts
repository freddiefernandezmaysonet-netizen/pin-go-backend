import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

function minutes(value: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("CLEANER_ACCESS_PROPERTY_TIME_INVALID");
  const [hour, minute] = value.split(":").map(Number);
  return hour! * 60 + minute!;
}

/** Access allowance only. Staff work commitments belong to stay-time eligibility. */
export function defaultCleanerAccessMinutes(checkOutTime: string | null, checkInTime: string | null): number {
  const duration = minutes(checkInTime ?? "15:00") - minutes(checkOutTime ?? "11:00") - 60;
  if (duration <= 0) throw new Error("CLEANER_ACCESS_WINDOW_EMPTY");
  return duration;
}

export function planCleanerAccessWindow(input: {
  checkOut: Date;
  property: { checkOutTime: string | null; checkInTime: string | null; timezone: string | null;
    cleaningStartOffsetMinutes: number };
  nextCheckIn: Date | null;
}) {
  const p = input.property;
  const durationMinutes = defaultCleanerAccessMinutes(p.checkOutTime, p.checkInTime);
  if (!Number.isFinite(input.checkOut.getTime()) || !Number.isSafeInteger(p.cleaningStartOffsetMinutes) ||
      p.cleaningStartOffsetMinutes < 0 || p.cleaningStartOffsetMinutes > 1440) {
    throw new Error("CLEANER_ACCESS_TIMING_INVALID");
  }
  const timezone = p.timezone ?? "America/Puerto_Rico";
  const day = formatInTimeZone(input.checkOut, timezone, "yyyy-MM-dd");
  const standardCheckIn = fromZonedTime(`${day}T${p.checkInTime ?? "15:00"}:00`, timezone);
  const nextMs = input.nextCheckIn?.getTime() ?? Infinity;
  if (Number.isNaN(nextMs) || !Number.isFinite(standardCheckIn.getTime())) throw new Error("CLEANER_ACCESS_TIMING_INVALID");
  const startsAt = new Date(input.checkOut.getTime() + p.cleaningStartOffsetMinutes * 60_000);
  const endsAt = new Date(Math.min(startsAt.getTime() + durationMinutes * 60_000, standardCheckIn.getTime(), nextMs));
  if (endsAt <= startsAt) throw new Error("CLEANER_ACCESS_WINDOW_EMPTY");
  return { startsAt, endsAt, durationMinutes };
}
