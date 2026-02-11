export function computeCleaningWindow(params: {
  checkOut: Date;
  cleaningStartOffsetMinutes: number; // ej 30
  cleaningDurationMinutes: number; // ej 180 o 240
}) {
  const start = new Date(
    params.checkOut.getTime() + params.cleaningStartOffsetMinutes * 60_000
  );

  const end = new Date(
    start.getTime() + params.cleaningDurationMinutes * 60_000
  );

  return { start, end };
}
