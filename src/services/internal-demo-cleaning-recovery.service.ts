import type { PrismaClient, Prisma } from "@prisma/client";
import { INTERNAL_DEMO_PROPERTY_ID, isInternalDemo } from "./internal-demo-scope.js";

type Actor = { userId: string; organizationId: string; role: string };
type Reader = Pick<PrismaClient | Prisma.TransactionClient, "reservation" | "nfcAssignment">;
export class DemoCleaningRecoveryError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
function authorize(actor: Actor) {
  if (actor.role !== "PLATFORM_ADMIN" || !actor.userId || !actor.organizationId) {
    throw new DemoCleaningRecoveryError("FORBIDDEN", 403);
  }
}
async function archiveContext(db: Reader, work: { reservationId: string; propertyId: string;
  scheduledStartAt: Date; durationCommitmentMinutes: number }, actor: Actor, now: Date) {
  if (work.propertyId !== INTERNAL_DEMO_PROPERTY_ID) return null;
  const reservation = await db.reservation.findFirst({ where: { id: work.reservationId,
    propertyId: INTERNAL_DEMO_PROPERTY_ID, property: { organizationId: actor.organizationId } }, include: { property: true } });
  if (!reservation || !isInternalDemo(reservation) || Number(reservation.totalAmount ?? 0) !== 0 ||
      reservation.stripeCheckoutSessionId || reservation.stripePaymentIntentId) return null;
  const expiresAt = new Date(Math.max(
    work.scheduledStartAt.getTime() + work.durationCommitmentMinutes * 60000,
    reservation.checkOut.getTime() + (reservation.property.cleaningStartOffsetMinutes + 30) * 60000,
  ));
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt >= now) return null;
  // An extended or future credential keeps this record out of administrative recovery.
  if (await db.nfcAssignment.findFirst({ where: { reservationId: reservation.id,
    role: "CLEANING", endsAt: { gte: now } }, select: { id: true } })) return null;
  return { reservation, expiresAt };
}

export async function readDemoCleaningBlockers(db: PrismaClient, actor: Actor, staffMemberId: string, now = new Date()) {
  authorize(actor);
  const works = await db.cleaningWork.findMany({ where: { staffMemberId, startConfirmedAt: { not: null },
    completionConfirmedAt: null, cancelledAt: null, supersededAt: null }, orderBy: { scheduledStartAt: "asc" } });
  const result = [];
  for (const work of works) {
    const context = await archiveContext(db, work, actor, now);
    result.push({ workId: work.id, reservationNumber: context?.reservation.reservationNumber ?? null,
      startedAt: work.startConfirmedAt, canArchive: Boolean(context) });
  }
  return result;
}

/** Administrative abandonment, never a cleaner completion or hardware operation. */
export async function archiveExpiredDemoCleaning(db: PrismaClient, actor: Actor, workId: string, now = new Date()) {
  authorize(actor);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(workId)) throw new DemoCleaningRecoveryError("INVALID_DEMO_WORK", 400);
  return db.$transaction(async tx => {
    const initial = await tx.cleaningWork.findUnique({ where: { id: workId } });
    if (!initial || initial.propertyId !== INTERNAL_DEMO_PROPERTY_ID) throw new DemoCleaningRecoveryError("DEMO_WORK_NOT_AVAILABLE", 404);
    // Same lock order as availability acceptance. Recheck every condition under the lock.
    await tx.$queryRaw`SELECT "id" FROM "StaffMember" WHERE "id" = ${initial.staffMemberId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${initial.reservationId} FOR UPDATE`;
    const work = await tx.cleaningWork.findUniqueOrThrow({ where: { id: workId } });
    const context = await archiveContext(tx, work, actor, now);
    if (!context || !work.confirmationId) throw new DemoCleaningRecoveryError("DEMO_WORK_NOT_ARCHIVABLE");
    const decisionId = `demo-cleaning-abandoned:${work.id}`;
    if (work.cancelledAt && await tx.apmsAuditEntry.findUnique({ where: { decisionId } })) return { replayed: true };
    if (!work.startConfirmedAt || work.completionConfirmedAt || work.cancelledAt || work.supersededAt) {
      throw new DemoCleaningRecoveryError("DEMO_WORK_CHANGED");
    }
    const closed = await tx.cleaningConfirmation.updateMany({ where: { id: work.confirmationId,
      reservationId: work.reservationId, propertyId: work.propertyId, staffMemberId: work.staffMemberId, status: "CONFIRMED" },
      data: { status: "CANCELLED" } });
    if (closed.count !== 1) throw new DemoCleaningRecoveryError("DEMO_WORK_CHANGED");
    await tx.cleaningWork.update({ where: { id: work.id }, data: { cancelledAt: now } });
    await tx.apmsAuditEntry.create({ data: { organizationId: actor.organizationId, propertyId: work.propertyId,
      reservationId: work.reservationId, entityType: "CLEANING", entityId: work.id, engine: "CLEANING",
      eventType: "ACTION_COMPLETED", status: "SUCCESS", severity: "INFO", decisionId,
      summary: "Expired Demo cleaning archived as abandoned", reason: "DEMO_TEST_ABANDONED",
      metadata: { actorUserId: actor.userId, startConfirmedAt: work.startConfirmedAt.toISOString(),
        completionRecorded: false, hardwareChanged: false }, startedAt: now, completedAt: now } });
    return { replayed: false };
  }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 10000 });
}
