const DEFAULT_TZ = "America/Puerto_Rico";

function getPRParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const pick = (type: string) => {
    const value = parts.find((p) => p.type === type)?.value;
    if (!value) throw new Error(`Missing ${type} in PR date parts`);
    return Number(value);
  };

  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

function getPuertoRicoOffsetMinutes(_date: Date) {
  // Puerto Rico no usa DST; UTC-4 todo el año.
  return -4 * 60;
}

function buildPRDate(year: number, month: number, day: number, hour: number, minute: number, second = 0) {
  const offsetMinutes = getPuertoRicoOffsetMinutes(new Date(Date.UTC(year, month - 1, day, hour, minute, second)));
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000;
  return new Date(utcMs);
}

function addDaysPR(year: number, month: number, day: number, days: number) {
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Ventana de limpieza 11:30 → 16:00 (hora PR).
 * Si el checkout ocurre después de 16:00 PR, mueve la limpieza al día siguiente.
 */
export function computeCleaningWindowPR(checkOut: Date) {
  const pr = getPRParts(checkOut);

  const isAfterWindow =
    pr.hour > 16 || (pr.hour === 16 && (pr.minute > 0 || pr.second > 0));

  const targetDate = isAfterWindow
    ? addDaysPR(pr.year, pr.month, pr.day, 1)
    : { year: pr.year, month: pr.month, day: pr.day };

  const startsAt = buildPRDate(targetDate.year, targetDate.month, targetDate.day, 11, 30, 0);
  const endsAt = buildPRDate(targetDate.year, targetDate.month, targetDate.day, 16, 0, 0);

  return { startsAt, endsAt, timezone: DEFAULT_TZ };
}