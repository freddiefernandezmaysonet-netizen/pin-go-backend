import type { Prisma } from "@prisma/client";
import { planCleanerAccessWindow } from "./cleaner-access-window.policy.js";

export type CleaningActionWindow = { startsAt: Date; latestStartAt: Date; latestCompletionAt: Date | null };
export class CleaningActionWindowError extends Error {}

export function assertCleaningActionTime(window: CleaningActionWindow, action: "start" | "complete", now: Date, startedAt?: Date | null) {
  const at = now.getTime();
  if (!Number.isFinite(at)) throw new CleaningActionWindowError("CLEANING_ACTION_INVALID_DATE");
  if (at < window.startsAt.getTime()) throw new CleaningActionWindowError("CLEANING_ACTION_TOO_EARLY");
  if (action === "start" && at >= window.latestStartAt.getTime()) throw new CleaningActionWindowError("CLEANING_START_WINDOW_CLOSED");
  if (action === "complete") {
    if (!startedAt || at < startedAt.getTime()) throw new CleaningActionWindowError("CLEANING_COMPLETION_BEFORE_START");
    if (window.latestCompletionAt && at >= window.latestCompletionAt.getTime()) throw new CleaningActionWindowError("CLEANING_COMPLETION_WINDOW_CLOSED");
  }
}

/** Read-only timing bounds. No access status, grant, NFC or reservation is mutated. */
export async function readCleaningActionWindow(tx: Prisma.TransactionClient, work: {
  reservationId: string; propertyId: string; staffMemberId: string; confirmationId: string | null; scheduledStartAt: Date;
}): Promise<CleaningActionWindow> {
  const reservation = await tx.reservation.findFirst({ where: { id: work.reservationId, propertyId: work.propertyId, status: "ACTIVE" }, include: { property: true } });
  if (!reservation || reservation.property.status !== "ACTIVE") throw new CleaningActionWindowError("CLEANING_ACTION_INACTIVE_CONTEXT");
  const [confirmation, assignment, access, next] = await Promise.all([
    tx.cleaningConfirmation.findFirst({ where: { id: work.confirmationId ?? "", reservationId: work.reservationId, propertyId: work.propertyId, staffMemberId: work.staffMemberId, status: "CONFIRMED" }, select: { id: true, updatedAt: true } }),
    tx.propertyStaff.findFirst({ where: { propertyId: work.propertyId, staffMemberId: work.staffMemberId, isActive: true, staffMember: { isActive: true, organizationId: reservation.property.organizationId } }, select: { id: true } }),
    tx.staffAssignment.findUnique({ where: { reservationId_staffMemberId: { reservationId: work.reservationId, staffMemberId: work.staffMemberId } }, select: { endsAt: true } }),
    // Same occupancy selection as cleaner-access-window.service.ts; includes overlaps.
    tx.reservation.findFirst({ where: { propertyId: work.propertyId, id: { not: work.reservationId }, status: { not: "CANCELLED" }, checkOut: { gt: reservation.checkOut } }, orderBy: { checkIn: "asc" }, select: { checkIn: true } }),
  ]);
  if (!confirmation || !assignment) throw new CleaningActionWindowError("CLEANING_ACTION_INACTIVE_CONTEXT");
  const planned = reservation.source === "INTERNAL_DEMO_DIRECT_BOOKING"
    ? { startsAt: new Date(reservation.checkOut.getTime() + reservation.property.cleaningStartOffsetMinutes * 60000),
        endsAt: new Date(Math.min(reservation.checkOut.getTime() + (reservation.property.cleaningStartOffsetMinutes + 30) * 60000, next?.checkIn.getTime() ?? Infinity)) }
    : planCleanerAccessWindow({ checkOut: reservation.checkOut, property: reservation.property, nextCheckIn: next?.checkIn ?? null });
  if (work.scheduledStartAt.getTime() !== planned.startsAt.getTime()) {
    const handoff = await tx.cleaningConfirmation.findFirst({ where: { reservationId: work.reservationId, propertyId: work.propertyId, status: "REASSIGNED" }, select: { id: true } });
    if (!handoff || !confirmation.updatedAt || work.scheduledStartAt.getTime() !== Math.max(planned.startsAt.getTime(), confirmation.updatedAt.getTime()) ||
        work.scheduledStartAt >= planned.endsAt) throw new CleaningActionWindowError("CLEANING_ACTION_SCHEDULE_CHANGED");
  }
  const startsAt = work.scheduledStartAt;
  const end = new Date(Math.min(planned.endsAt.getTime(), access?.endsAt.getTime() ?? Infinity, next?.checkIn.getTime() ?? Infinity));
  if (!Number.isFinite(end.getTime()) || end <= startsAt) throw new CleaningActionWindowError("CLEANING_ACTION_WINDOW_EMPTY");
  return { startsAt, latestStartAt: end, latestCompletionAt: next ? end : null };
}
