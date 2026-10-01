import type { Prisma } from "@prisma/client";
import type { StayTimeEvidence } from "../pin-ai/actions/stay-time-policy.js";

/** Read inside the estimator's snapshot. Completion is operational evidence,
 * not a physical inspection, guest authorization or hardware readiness claim. */
export async function readArrivalCleaningReadiness(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; propertyId: string; reservationId: string;
    checkIn: Date; requestedAt: Date; now: Date; cleaningStartOffsetMinutes: number },
): Promise<StayTimeEvidence["arrivalReadiness"]> {
  const { organizationId, propertyId, reservationId, checkIn, requestedAt, now } = input;
  const offset = input.cleaningStartOffsetMinutes;
  if (!Number.isInteger(offset) || offset < 0 || offset > 1440) return null;
  // Select the most recent departing stay, never an arbitrary completed work
  // item or the arriving guest's own post-checkout cleaning.
  const prior = await tx.reservation.findFirst({
    where: { id: { not: reservationId }, propertyId, property: { organizationId },
      status: "ACTIVE", checkIn: { lt: checkIn } },
    orderBy: [{ checkOut: "desc" }, { id: "asc" }],
    select: { id: true, checkOut: true },
  });
  if (!prior || !(prior.checkOut instanceof Date) || prior.checkOut > now || prior.checkOut > requestedAt) return null;
  const works = await tx.cleaningWork.findMany({
    where: { propertyId, reservationId: prior.id, cancelledAt: null, supersededAt: null },
    take: 2,
    select: { id: true, staffMemberId: true, confirmationId: true, scheduledStartAt: true,
      timingConsentVersion: true, timingConsentAcceptedAt: true, startConfirmedAt: true, completionConfirmedAt: true },
  });
  // Multiple current assignments require reconciliation, not choosing the one
  // that happens to have a completion timestamp.
  if (works.length !== 1) return null;
  const work = works[0]!;
  const consent = work.timingConsentAcceptedAt;
  const start = work.startConfirmedAt;
  const completed = work.completionConfirmedAt;
  if (!work.confirmationId || !work.timingConsentVersion?.trim() || !consent || !start || !completed ||
      ![consent, start, completed, work.scheduledStartAt].every(d => d instanceof Date && Number.isFinite(d.getTime())) ||
      consent > start || start < prior.checkOut || start > completed || completed > now || completed > requestedAt ||
      work.scheduledStartAt.getTime() !== prior.checkOut.getTime() + offset * 60_000) return null;
  const confirmation = await tx.cleaningConfirmation.findFirst({
    where: { id: work.confirmationId, propertyId, reservationId: prior.id, staffMemberId: work.staffMemberId, status: "CONFIRMED" },
    select: { id: true },
  });
  const assignment = await tx.propertyStaff.findFirst({
    where: { propertyId, staffMemberId: work.staffMemberId, isActive: true,
      staffMember: { organizationId, isActive: true } }, select: { id: true },
  });
  if (!confirmation || !assignment) return null;
  // An owner block or occupancy since completion can invalidate otherwise valid
  // work even when it ends before the requested early-arrival time.
  const occupied = await tx.reservation.findFirst({
    where: { id: { not: reservationId }, propertyId, property: { organizationId }, status: "ACTIVE",
      checkIn: { lt: checkIn }, checkOut: { gt: completed } }, select: { id: true },
  });
  const blocked = await tx.propertyBlockedDate.findFirst({
    where: { propertyId, property: { organizationId }, startDate: { lt: checkIn }, endDate: { gt: completed } },
    select: { id: true },
  });
  const pendingChange = await tx.reservationModification.findFirst({
    where: { reservation: { propertyId, property: { organizationId } }, AND: [
      { OR: [{ reservationId: prior.id }, { proposedCheckIn: { lt: checkIn }, proposedCheckOut: { gt: completed } }] },
      { OR: [{ status: "PAYMENT_PROCESSING" }, { status: "APPLYING" },
        { status: "AWAITING_PAYMENT", checkoutExpiresAt: { gt: now } }] },
    ] }, select: { id: true },
  });
  if (occupied || blocked || pendingChange) return null;
  return { arrivingReservationId: reservationId, scheduledCheckIn: checkIn,
    status: "READY", evidenceId: `cleaning-completion:${work.id}:${completed.toISOString()}`,
    assessedAt: now };
}
