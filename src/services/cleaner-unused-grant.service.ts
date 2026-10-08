import type { PrismaClient } from "@prisma/client";

/** Retire only an unused grant provably owned by a withdrawn cleaner.
 * The CAS competes with worker claims; this never calls a physical provider. */
export async function retireUnusedWithdrawnCleanerGrant(db: PrismaClient, input: {
  reservationId: string;
  propertyId: string;
  confirmationId: string;
  grantId: string;
  grantCardId: string;
  replacementCardId: string;
}): Promise<boolean> {
  if (input.grantCardId === input.replacementCardId) return false;
  return db.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT id FROM "Reservation" WHERE id = $1 FOR UPDATE', input.reservationId);
    const current = await tx.cleaningConfirmation.findMany({
      where: { reservationId: input.reservationId, status: { in: ["PENDING", "CONFIRMED"] } },
      select: { id: true, propertyId: true, status: true }, take: 2,
    });
    if (current.length !== 1 || current[0]?.id !== input.confirmationId ||
        current[0].propertyId !== input.propertyId || current[0].status !== "CONFIRMED") return false;

    const withdrawn = await tx.cleaningConfirmation.findMany({
      where: { reservationId: input.reservationId, propertyId: input.propertyId,
        status: { in: ["CANCELLED", "DECLINED", "EXPIRED", "REASSIGNED"] } },
      select: { staffMemberId: true },
    });
    if (!withdrawn.length) return false;
    const formerStaff = await tx.staffMember.findMany({
      where: { id: { in: withdrawn.map(offer => offer.staffMemberId) } },
      select: { ttlockCardRef: true },
    });
    const labels = formerStaff.map(staff => String(staff.ttlockCardRef ?? "").trim()).filter(Boolean);
    if (!labels.length) return false;
    const formerCard = await tx.nfcCard.findFirst({
      where: { id: input.grantCardId, propertyId: input.propertyId, label: { in: labels } },
      select: { id: true },
    });
    if (!formerCard) return false;

    const retired = await tx.nfcAssignment.updateMany({
      where: { id: input.grantId, reservationId: input.reservationId,
        nfcCardId: input.grantCardId, role: "CLEANING", status: "SCHEDULED",
        retryCount: 0, provisioningStartedAt: null, provisionedAt: null,
        cleanerProgrammingAttempts: { none: {} } },
      data: { status: "ENDED", lastError: "CLEANER_UNUSED_GRANT_WITHDRAWN" },
    });
    return retired.count === 1;
  }, { maxWait: 5_000, timeout: 10_000 });
}

/** Explicitly cancelled former programmed or in-flight permission may expire naturally.
 * Schedule the accepting replacement's own card without altering the former grant. */
export async function scheduleBackupAlongsideCancelledProgrammedGrant(db: PrismaClient, input: {
  reservationId: string; propertyId: string; confirmationId: string;
  grantId: string; grantCardId: string; replacementCardId: string;
  startsAt: Date; endsAt: Date;
}): Promise<string | null> {
  if (input.grantCardId === input.replacementCardId) return null;
  return db.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT id FROM "Reservation" WHERE id = $1 FOR UPDATE', input.reservationId);
    const reservation = await tx.reservation.findUnique({ where: { id: input.reservationId }, select: { status: true, propertyId: true } });
    if (!reservation || reservation.status !== "ACTIVE" || reservation.propertyId !== input.propertyId) return null;
    const current = await tx.cleaningConfirmation.findMany({ where: {
      reservationId: input.reservationId, status: { in: ["PENDING", "CONFIRMED"] },
    }, take: 2 });
    const offer = current[0];
    if (current.length !== 1 || !offer || offer.id !== input.confirmationId ||
        offer.propertyId !== input.propertyId || offer.status !== "CONFIRMED") return null;
    const cancelled = await tx.cleaningConfirmation.findMany({ where: {
      reservationId: input.reservationId, propertyId: input.propertyId, status: { in: ["CANCELLED", "REASSIGNED"] },
    }, select: { staffMemberId: true } });
    if (!cancelled.length) return null;
    const former = await tx.staffMember.findMany({ where: { id: { in: cancelled.map(o => o.staffMemberId) } }, select: { ttlockCardRef: true } });
    const labels = former.map(s => String(s.ttlockCardRef ?? "").trim()).filter(Boolean);
    if (!labels.length || !await tx.nfcCard.findFirst({ where: {
      id: input.grantCardId, propertyId: input.propertyId, label: { in: labels },
    }, select: { id: true } })) return null;
    const accepting = await tx.staffMember.findUnique({ where: { id: offer.staffMemberId } });
    const ref = String(accepting?.ttlockCardRef ?? "").trim();
    if (!ref || !await tx.nfcCard.findFirst({ where: {
      id: input.replacementCardId, propertyId: input.propertyId, label: ref,
    }, select: { id: true } })) return null;
    const prior = await tx.nfcAssignment.findFirst({ where: {
      id: input.grantId, reservationId: input.reservationId,
      nfcCardId: input.grantCardId, role: "CLEANING", status: { in: ["ACTIVE", "PROVISIONING", "FAILED"] },
    } });
    if (!prior || !["ACTIVE", "PROVISIONING", "FAILED"].includes(prior.status)) return null;
    const own = await tx.nfcAssignment.findFirst({ where: {
      reservationId: input.reservationId, nfcCardId: input.replacementCardId, role: "CLEANING",
      status: { in: ["SCHEDULED", "PROVISIONING", "ACTIVE"] },
    } });
    if (own) return own.startsAt.getTime() === input.startsAt.getTime() &&
      own.endsAt.getTime() === input.endsAt.getTime() ? own.id : null;
    if (await tx.nfcAssignment.findFirst({ where: {
      nfcCardId: input.replacementCardId, reservationId: { not: input.reservationId },
      status: { in: ["SCHEDULED", "PROVISIONING", "ACTIVE"] },
      startsAt: { lt: input.endsAt }, endsAt: { gt: input.startsAt },
    } })) return null;
    return (await tx.nfcAssignment.create({ data: {
      reservationId: input.reservationId, nfcCardId: input.replacementCardId,
      role: "CLEANING", status: "SCHEDULED", startsAt: input.startsAt, endsAt: input.endsAt,
      retryCount: 0, provisioningStartedAt: null, provisionedAt: null, lastError: null,
    } })).id;
  }, { maxWait: 5_000, timeout: 10_000 });
}
