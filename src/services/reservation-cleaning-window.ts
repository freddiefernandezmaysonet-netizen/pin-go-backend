type CleaningAssignment = {
  role: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
};

/** The departure, not the arrival, determines this stay's turnover schedule.
 * Access expiry can shorten independently of the accepted cleaning start.
 */
export function planCleaningWindow(input: {
  checkOut: Date;
  previousCheckOut: Date | null;
  enabled: boolean;
  accessWindow: { startsAt: Date; endsAt: Date } | null;
  assignments: readonly CleaningAssignment[];
}) {
  const startsAt = input.accessWindow?.startsAt ?? null;
  const endsAt = input.accessWindow?.endsAt ?? null;
  const checkoutChanged = input.previousCheckOut !== null &&
    input.previousCheckOut.getTime() !== input.checkOut.getTime();
  const live = input.assignments.filter(a => a.role === "CLEANING" && a.status !== "FAILED" && a.status !== "ENDED");
  const startChanged = startsAt !== null && live.some(a => a.startsAt.getTime() !== startsAt.getTime());
  const accessChanged = startsAt !== null && endsAt !== null && live.some(a =>
    a.startsAt.getTime() !== startsAt.getTime() || a.endsAt.getTime() !== endsAt.getTime());
  return { startsAt, endsAt,
    requiresReconfirmation: input.enabled && (checkoutChanged || startChanged),
    requiresAccessReschedule: input.enabled && accessChanged };
}
