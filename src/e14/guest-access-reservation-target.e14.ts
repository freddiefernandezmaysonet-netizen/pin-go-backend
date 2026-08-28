export type GuestAccessReservationTargetCandidate = {
  id: string;
  startsAt: Date;
  endsAt: Date;
};

export type GuestAccessReservationWindow = {
  checkIn: Date;
  checkOut: Date;
};

function sameInstant(left: unknown, right: unknown): boolean {
  return (
    left instanceof Date &&
    right instanceof Date &&
    left.getTime() === right.getTime()
  );
}

/**
 * Selects the canonical current-window grant before the reservation worker
 * enters its single-outcome loop. The reservation-level fence remains the
 * authority for cardinality and sibling-state validation:
 *
 * - one canonical candidate is selected even when an older sibling sorts first;
 * - zero canonical candidates fall back to one deterministic target so the
 *   fence can quarantine the invalid set;
 * - multiple canonical candidates select one deterministic target so the
 *   fence can fail closed after observing the complete reservation grant set.
 */
export function selectGuestAccessReservationTarget<
  T extends GuestAccessReservationTargetCandidate,
>(
  grants: readonly T[],
  reservation: GuestAccessReservationWindow
): T | null {
  const first = grants[0] ?? null;
  if (!first) return null;

  return (
    grants.find(
      (grant) =>
        sameInstant(grant.startsAt, reservation.checkIn) &&
        sameInstant(grant.endsAt, reservation.checkOut)
    ) ?? first
  );
}
