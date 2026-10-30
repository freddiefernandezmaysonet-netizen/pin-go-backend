import { INTERNAL_DEMO_PROPERTY_ID } from "./internal-demo-scope";

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

/** Legacy Lodgify demo imports audited on 2026-10-30 ended by October 5.
 * A fixed cutoff prevents this exception from expanding to future demo stays.
 * Any unresolved cleaner assignment still requires the normal safety reconciliation,
 * even when its recorded end date is already past.
 */
export function isHistoricalDemoWithoutCleanerAccess(input: {
  propertyId: string;
  source: string | null;
  checkOut: Date;
  assignments: readonly Pick<CleaningAssignment, "role" | "status">[];
  now: Date;
}) {
  const checkout = input.checkOut.getTime();
  return input.propertyId === INTERNAL_DEMO_PROPERTY_ID && input.source === "LODGIFY" &&
    Number.isFinite(checkout) && Number.isFinite(input.now.getTime()) &&
    checkout < Date.parse("2026-10-06T00:00:00Z") && checkout < input.now.getTime() &&
    !input.assignments.some(a => a.role === "CLEANING" && a.status !== "ENDED" && a.status !== "FAILED");
}
