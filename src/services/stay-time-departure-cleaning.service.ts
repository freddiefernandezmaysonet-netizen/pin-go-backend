import type { Prisma } from "@prisma/client";
import { StayTimePolicyError } from "../pin-ai/actions/stay-time-policy.js";

function reject(): never { throw new StayTimePolicyError("DEPARTURE_CLEANING_COMMITMENT_REQUIRED"); }

/** Read in the same snapshot as reservation, price and availability. Never infer
 * the assigned cleaner from PRIMARY/BACKUP order or a property-wide duration. */
export async function readStayTimeDepartureCleaning(tx: Prisma.TransactionClient, input: {
  organizationId: string; propertyId: string; reservationId: string;
  checkOut: Date; cleaningStartOffsetMinutes: number; now: Date;
}) {
  const { organizationId, propertyId, reservationId, checkOut, now } = input;
  const offset = input.cleaningStartOffsetMinutes;
  if (!Number.isInteger(offset) || offset < 0 || offset > 1440) reject();
  const works = await tx.cleaningWork.findMany({
    where: { reservationId, cancelledAt: null, supersededAt: null }, take: 2,
    select: { id: true, propertyId: true, staffMemberId: true, confirmationId: true,
      scheduledStartAt: true, durationCommitmentMinutes: true, timingConsentVersion: true,
      timingConsentAcceptedAt: true, startConfirmedAt: true, completionConfirmedAt: true },
  });
  if (works.length !== 1) reject();
  const work = works[0]!;
  const consent = work.timingConsentAcceptedAt;
  if (work.propertyId !== propertyId || !work.confirmationId || !work.timingConsentVersion?.trim() ||
      !consent || !Number.isFinite(consent.getTime()) || consent > now ||
      !Number.isFinite(work.scheduledStartAt.getTime()) ||
      work.scheduledStartAt.getTime() !== checkOut.getTime() + offset * 60_000 ||
      work.startConfirmedAt || work.completionConfirmedAt ||
      !Number.isInteger(work.durationCommitmentMinutes) || work.durationCommitmentMinutes < 15 ||
      work.durationCommitmentMinutes > 1440) reject();
  const confirmations = await tx.cleaningConfirmation.findMany({
    where: { reservationId, status: { in: ["PENDING", "CONFIRMED"] } }, take: 2,
    select: { id: true, propertyId: true, staffMemberId: true, status: true },
  });
  const confirmation = confirmations[0];
  if (confirmations.length !== 1 || confirmation?.id !== work.confirmationId ||
      confirmation.propertyId !== propertyId || confirmation.staffMemberId !== work.staffMemberId ||
      confirmation.status !== "CONFIRMED") reject();
  const assignment = await tx.propertyStaff.findFirst({ where: {
    propertyId, staffMemberId: work.staffMemberId, isActive: true,
    property: { organizationId, status: "ACTIVE", cleaningNfcEnabled: true },
    staffMember: { organizationId, isActive: true },
  }, select: { id: true, cleaningDurationCommitmentMinutes: true } });
  // Editing the cleaner's configuration does not silently rewrite their existing
  // accepted work. Require a consistent current snapshot before a new guest offer.
  if (!assignment || assignment.cleaningDurationCommitmentMinutes !== work.durationCommitmentMinutes) reject();
  return { version: "departure_cleaning_v1" as const, workId: work.id,
    confirmationId: work.confirmationId, staffMemberId: work.staffMemberId, assignmentId: assignment.id,
    durationMinutes: work.durationCommitmentMinutes, offsetMinutes: offset,
    scheduledStartAt: work.scheduledStartAt.toISOString(), timingConsentVersion: work.timingConsentVersion,
    timingConsentAcceptedAt: consent.toISOString() };
}
