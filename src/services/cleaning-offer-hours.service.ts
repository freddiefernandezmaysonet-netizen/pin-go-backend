import type { Prisma, PrismaClient } from "@prisma/client";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { readCleanerAccessWindow } from "./cleaner-access-window.service.js";
import { upsertOperationalIssue } from "../apms/operational-intelligence.service.js";

export function isWithinCleaningMessageHours(timeZone: string, now: Date) {
  const hour = Number(formatInTimeZone(now, timeZone, "H"));
  return hour >= 8 && hour < 18;
}
export function deferredCleaningOfferNeedsHost(input: { now: Date; timezone: string; startsAt: Date; endsAt: Date; durationMinutes: number | null }) {
  if (isWithinCleaningMessageHours(input.timezone, input.now)) return false;
  let day = formatInTimeZone(input.now, input.timezone, "yyyy-MM-dd");
  let next = fromZonedTime(`${day}T08:00:00`, input.timezone);
  if (next <= input.now) {
    day = new Date(new Date(`${day}T12:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
    next = fromZonedTime(`${day}T08:00:00`, input.timezone);
  }
  const minutes = input.durationMinutes;
  return minutes === null || !Number.isSafeInteger(minutes) || minutes <= 0 ||
    Math.max(next.getTime(), input.startsAt.getTime()) + minutes * 60000 >= input.endsAt.getTime();
}
/** Preserve 08:00–18:00 SMS hours. If waiting makes the offer infeasible,
 * keep it pending and alert the host in Mission Control without another SMS. */
export async function recordDeferredCleaningOfferAttention(db: PrismaClient, confirmationId: string, now: Date) {
  return db.$transaction(async tx => {
    const preview = await tx.cleaningConfirmation.findUnique({ where: { id: confirmationId } });
    if (!preview) return;
    await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${preview.reservationId} FOR UPDATE`;
    const offer = await tx.cleaningConfirmation.findUnique({ where: { id: confirmationId } });
    if (!offer || offer.status !== "PENDING") return;
    const reservation = await tx.reservation.findFirst({ where: { id: offer.reservationId, propertyId: offer.propertyId,
      status: "ACTIVE", property: { status: "ACTIVE" } }, include: { property: true } });
    if (!reservation) return;
    const staff = await tx.propertyStaff.findFirst({ where: { propertyId: offer.propertyId, staffMemberId: offer.staffMemberId,
      isActive: true, staffMember: { isActive: true, organizationId: reservation.property.organizationId } } });
    if (!staff) return;
    let needsHost = true;
    try {
      const window = await readCleanerAccessWindow(tx, reservation);
      needsHost = deferredCleaningOfferNeedsHost({ now, timezone: reservation.property.timezone ?? "America/Puerto_Rico",
        startsAt: window.startsAt, endsAt: window.endsAt, durationMinutes: staff.cleaningDurationCommitmentMinutes });
    } catch { /* Unknown/empty current window requires human review. */ }
    if (!needsHost) return;
    await upsertOperationalIssue(tx, {
      operationalKey: `CLEANING_OFFER_HOURS:${offer.id}`, issueCode: "CLEANING_URGENT_OFFER_DEFERRED",
      title: "Urgent cleaner offer outside SMS hours", issue: "Waiting until the next permitted SMS hour cannot establish viable cleaning coverage.",
      engine: "Cleaning", severity: "WARNING", workflowState: "ACTION_REQUIRED", visibility: "HOST", responsibleActor: "HOST",
      actionRequired: true, canAutoResolve: true, autoResolveStatus: "AVAILABLE", sourceType: "WORKER", actionTarget: "CLEANING",
      organizationId: reservation.property.organizationId, propertyId: offer.propertyId, reservationId: offer.reservationId,
      reservationNumber: reservation.reservationNumber, recommendedAction: "Arrange timely coverage or review the next arrival. The backup must explicitly accept.",
      metadata: { confirmationId: offer.id, smsHoursOverridden: false, cleanerAccepted: false },
      transitionCode: "CLEANING_URGENT_OFFER_DEFERRED", transitionSummary: "SMS hours preserved; deadline needs host review.",
      transitionedBy: "PIN_GO", occurredAt: now, lastSignalAt: now,
    });
  });
}
export async function resolveDeferredCleaningOfferAttention(db: PrismaClient | Prisma.TransactionClient, confirmationId: string, now: Date) {
  const key = `CLEANING_OFFER_HOURS:${confirmationId}`;
  const previous = await db.operationalIssue.findUnique({ where: { operationalKey: key } });
  if (!previous || previous.workflowState === "RESOLVED") return;
  await upsertOperationalIssue(db, {
    operationalKey: key, issueCode: "CLEANING_OFFER_HOURS_HANDLED", title: "Deferred cleaner offer handled",
    issue: "The offer was delivered, explicitly accepted or withdrawn; its original quiet-hours alert is superseded.",
    engine: "Cleaning", severity: "INFO", workflowState: "RESOLVED", visibility: "SYSTEM", responsibleActor: "PIN_GO",
    actionRequired: false, canAutoResolve: true, autoResolveStatus: "SUCCEEDED", sourceType: "WORKER", actionTarget: "CLEANING",
    organizationId: previous.organizationId, propertyId: previous.propertyId, reservationId: previous.reservationId,
    resolutionCode: "CLEANING_OFFER_HOURS_HANDLED", resolutionSummary: "The pending-delivery alert is superseded; cleaning completion is not inferred.",
    resolutionType: "SUPERSEDED", resolvedBy: "PIN_GO", resolvedAt: now,
    transitionCode: "CLEANING_OFFER_HOURS_HANDLED", transitionSummary: "Deferred-offer attention closed.",
    transitionedBy: "PIN_GO", occurredAt: now, lastSignalAt: now,
  });
}
