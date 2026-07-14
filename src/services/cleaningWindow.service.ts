const DEFAULT_TZ = "America/Puerto_Rico";

function getZonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
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
    if (!value) throw new Error(`Missing ${type} in zoned date parts`);
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

function getOffsetMinutesForTimeZone(date: Date, timeZone: string) {
  const zoned = getZonedParts(date, timeZone);
  const asUtcMs = Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.day,
    zoned.hour,
    zoned.minute,
    zoned.second
  );

  return Math.round((asUtcMs - date.getTime()) / 60_000);
}

function buildZonedDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
) {
  const approxUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offsetMinutes = getOffsetMinutesForTimeZone(approxUtc, timeZone);
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000;
  return new Date(utcMs);
}

function addDays(year: number, month: number, day: number, days: number) {
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Ventana de limpieza 11:30 → 16:00 en el timezone de la propiedad.
 * Si el checkout ocurre después de 16:00 local, mueve la limpieza al día siguiente.
 */
export function computeCleaningWindow(
  checkOut: Date,
  timeZone: string = DEFAULT_TZ
) {
  const zoned = getZonedParts(checkOut, timeZone);

  const isAfterWindow =
    zoned.hour > 16 || (zoned.hour === 16 && (zoned.minute > 0 || zoned.second > 0));

  const targetDate = isAfterWindow
    ? addDays(zoned.year, zoned.month, zoned.day, 1)
    : { year: zoned.year, month: zoned.month, day: zoned.day };

  const startsAt = buildZonedDate(
    targetDate.year,
    targetDate.month,
    targetDate.day,
    11,
    30,
    0,
    timeZone
  );

  const endsAt = buildZonedDate(
    targetDate.year,
    targetDate.month,
    targetDate.day,
    16,
    0,
    0,
    timeZone
  );

  return { startsAt, endsAt, timezone: timeZone };
}

/**
 * Compatibilidad temporal con código viejo.
 * Mantiene Puerto Rico por defecto.
 */
export function computeCleaningWindowPR(checkOut: Date) {
  return computeCleaningWindow(checkOut, DEFAULT_TZ);
}