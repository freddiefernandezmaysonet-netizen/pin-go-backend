const DEFAULT_TZ = "America/Puerto_Rico";

/**
 * Ventana de limpieza 11:30 → 16:00 (hora PR).
 * Si el checkout ocurre después de 16:00 PR, mueve la limpieza al día siguiente.
 */
export function computeCleaningWindowPR(checkOut: Date) {
  // “fecha local PR”
  const local = new Date(checkOut.toLocaleString("en-US", { timeZone: DEFAULT_TZ }));

  const y = local.getFullYear();
  const m = local.getMonth();
  const d = local.getDate();

  const startLocal = new Date(y, m, d, 11, 30, 0, 0);
  const endLocal   = new Date(y, m, d, 16, 0, 0, 0);

  if (local.getTime() > endLocal.getTime()) {
    startLocal.setDate(startLocal.getDate() + 1);
    endLocal.setDate(endLocal.getDate() + 1);
  }

  // Convertimos a Date “real” (UTC) re-interpretando en PR
  const startsAt = new Date(startLocal.toLocaleString("en-US", { timeZone: DEFAULT_TZ }));
  const endsAt   = new Date(endLocal.toLocaleString("en-US", { timeZone: DEFAULT_TZ }));

  return { startsAt, endsAt, timezone: DEFAULT_TZ };
}
