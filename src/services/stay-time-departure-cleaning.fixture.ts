import type { PrismaClient, Reservation } from "@prisma/client";

/** Isolated database tests only; never called by application code. */
export async function createStayTimeDepartureCleaningFixture(db: PrismaClient, reservation: Reservation,
  now: Date, durationMinutes = 180) {
  const property = await db.property.findUniqueOrThrow({ where: { id: reservation.propertyId } });
  const staff = await db.staffMember.create({ data: { organizationId: property.organizationId, fullName: "Synthetic departure cleaner" } });
  const assignment = await db.propertyStaff.create({ data: { propertyId: property.id, staffMemberId: staff.id,
    role: "PRIMARY", cleaningDurationCommitmentMinutes: durationMinutes } });
  const confirmation = await db.cleaningConfirmation.create({ data: { reservationId: reservation.id,
    propertyId: property.id, staffMemberId: staff.id, status: "CONFIRMED", token: `synthetic-departure-${staff.id}` } });
  const work = await db.cleaningWork.create({ data: { reservationId: reservation.id, propertyId: property.id,
    staffMemberId: staff.id, confirmationId: confirmation.id,
    scheduledStartAt: new Date(reservation.checkOut.getTime() + property.cleaningStartOffsetMinutes * 60_000),
    durationCommitmentMinutes: durationMinutes, startConfirmationGraceMinutes: 5, followupGraceMinutes: 5,
    timingConsentVersion: "v1", timingConsentAcceptedAt: new Date(now.getTime() - 60_000) } });
  return { staffId: staff.id, workId: work.id, assignmentId: assignment.id, confirmationId: confirmation.id };
}
