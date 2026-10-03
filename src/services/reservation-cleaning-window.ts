type CleaningAssignment = {
  role: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
};

/** The departure, not the arrival, determines this stay's turnover schedule.
 * Non-NFC cleaning is not activated by this legacy NFC-flow policy.
 */
export function planCleaningWindow(input: {
  checkOut: Date;
  previousCheckOut: Date | null;
  enabled: boolean;
  offsetMinutes: number;
  durationMinutes: number;
  assignments: readonly CleaningAssignment[];
}) {
  const startsAt = new Date(input.checkOut.getTime() + input.offsetMinutes * 60_000);
  const endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000);
  const checkoutChanged = input.previousCheckOut !== null &&
    input.previousCheckOut.getTime() !== input.checkOut.getTime();
  const scheduleMismatch = input.assignments.some(a =>
    a.role === "CLEANING" && a.status !== "FAILED" && a.status !== "ENDED" &&
    (a.startsAt.getTime() !== startsAt.getTime() || a.endsAt.getTime() !== endsAt.getTime()),
  );
  return { startsAt, endsAt, requiresReconfirmation: input.enabled && (checkoutChanged || scheduleMismatch) };
}
