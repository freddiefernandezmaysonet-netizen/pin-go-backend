import { cleaningPinAIRecoveryAllowed } from "./cleaning-pin-ai-activation.service.js";
import { randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { planCleanerAccessWindow } from "./cleaner-access-window.policy.js";
import { recordCleaningBackupExhaustion, resolveWithdrawnCleaningOfferAttention } from "./cleaning-reassignment-attention.service.js";
import { assessLatestCleaningIssue } from "./cleaning-issue-assessment.service.js";
import { resolveDeferredCleaningOfferAttention } from "./cleaning-offer-hours.service.js";

export class CleaningReassignmentError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
type Scope = { confirmationId: string; staffMemberId: string; organizationId: string };
async function atomic<T>(db: PrismaClient, run: (tx: Prisma.TransactionClient) => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(run, { isolationLevel: "Serializable", maxWait: 5000, timeout: 10000 }); }
    catch (error) {
      if (attempt >= 2 || !(error instanceof Prisma.PrismaClientKnownRequestError) || !["P2034", "P2002"].includes(error.code)) throw error;
    }
  }
}
async function context(tx: Prisma.TransactionClient, scope: Scope) {
  const offer = await tx.cleaningConfirmation.findFirst({ where: { id: scope.confirmationId, staffMemberId: scope.staffMemberId } });
  if (!offer) throw new CleaningReassignmentError("CLEANING_NOT_AVAILABLE", 404);
  await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${offer.reservationId} FOR UPDATE`;
  const reservation = await tx.reservation.findFirst({ where: { id: offer.reservationId, propertyId: offer.propertyId, status: "ACTIVE", property: { organizationId: scope.organizationId, status: "ACTIVE" } }, include: { property: true } });
  const staff = await tx.propertyStaff.findFirst({ where: { propertyId: offer.propertyId, staffMemberId: scope.staffMemberId, isActive: true, staffMember: { isActive: true, organizationId: scope.organizationId } } });
  if (!reservation || !staff) throw new CleaningReassignmentError("CLEANING_NOT_AVAILABLE", 404);
  const current = await tx.cleaningConfirmation.findUniqueOrThrow({ where: { id: offer.id } });
  return { offer: current, reservation };
}
type Context = Awaited<ReturnType<typeof context>>;
function attentionContext(ctx: Context, occurredAt: Date) {
  return { reservationId: ctx.reservation.id, propertyId: ctx.reservation.propertyId,
    organizationId: ctx.reservation.property.organizationId, propertyName: ctx.reservation.property.name,
    reservationNumber: ctx.reservation.reservationNumber, occurredAt };
}
async function schedule(tx: Prisma.TransactionClient, ctx: Context, now: Date) {
  const next = await tx.reservation.findFirst({ where: { propertyId: ctx.reservation.propertyId, id: { not: ctx.reservation.id }, status: { not: "CANCELLED" }, checkOut: { gt: ctx.reservation.checkOut } }, orderBy: { checkIn: "asc" }, select: { checkIn: true } });
  const { reservation: r } = ctx;
  const window = r.source === "INTERNAL_DEMO_DIRECT_BOOKING"
    ? { startsAt: new Date(r.checkOut.getTime() + r.property.cleaningStartOffsetMinutes * 60000), endsAt: new Date(Math.min(r.checkOut.getTime() + (r.property.cleaningStartOffsetMinutes + 30) * 60000, next?.checkIn.getTime() ?? Infinity)) }
    : planCleanerAccessWindow({ checkOut: r.checkOut, property: r.property, nextCheckIn: next?.checkIn ?? null });
  return { ...window, earliestActualStart: new Date(Math.max(window.startsAt.getTime(), now.getTime())), next };
}
async function viable(tx: Prisma.TransactionClient, ctx: Context, assignment: { staffMemberId: string; cleaningDurationCommitmentMinutes: number | null }, bounds: Awaited<ReturnType<typeof schedule>>) {
  const minutes = assignment.cleaningDurationCommitmentMinutes;
  if (minutes === null || !Number.isSafeInteger(minutes) || minutes < 15 || minutes > 1440 || bounds.earliestActualStart >= bounds.endsAt) return false;
  const finish = new Date(bounds.earliestActualStart.getTime() + minutes * 60000);
  if (bounds.next && finish >= bounds.endsAt) return false;
  const works = await tx.cleaningWork.findMany({ where: { staffMemberId: assignment.staffMemberId, reservationId: { not: ctx.reservation.id }, cancelledAt: null, supersededAt: null, completionConfirmedAt: null } });
  return !works.some(work => {
    const end = work.scheduledStartAt.getTime() + work.durationCommitmentMinutes * 60000;
    // An unfinished started task is still occupied beyond its estimate.
    return work.scheduledStartAt < finish && (end > bounds.earliestActualStart.getTime() || Boolean(work.startConfirmedAt));
  });
}
async function nextOffer(tx: Prisma.TransactionClient, ctx: Context, now: Date, requireWindowFit = false) {
  const existing = await tx.cleaningConfirmation.findFirst({ where: { reservationId: ctx.reservation.id, status: { in: ["PENDING", "CONFIRMED"] } } });
  if (existing) throw new CleaningReassignmentError("CLEANING_OTHER_OFFER_ACTIVE");
  const attempts = await tx.cleaningConfirmation.findMany({ where: { reservationId: ctx.reservation.id }, select: { staffMemberId: true } });
  const assignments = await tx.propertyStaff.findMany({ where: { propertyId: ctx.reservation.propertyId, isActive: true, staffMemberId: { notIn: attempts.map(a => a.staffMemberId) }, staffMember: { isActive: true, organizationId: ctx.reservation.property.organizationId, phoneE164: { not: null } } }, include: { staffMember: true } });
  assignments.sort((a, b) => ((a.role === "PRIMARY" ? 0 : 1) - (b.role === "PRIMARY" ? 0 : 1) || (a.backupOrder ?? 0) - (b.backupOrder ?? 0)) || a.id.localeCompare(b.id));
  const bounds = await schedule(tx, ctx, now);
  for (const candidate of assignments) {
    if (!candidate.staffMember.phoneE164?.trim() || !await viable(tx, ctx, candidate, bounds)) continue;
    if (requireWindowFit && bounds.earliestActualStart.getTime() + candidate.cleaningDurationCommitmentMinutes! * 60000 >= bounds.endsAt.getTime()) continue;
    const offer = await tx.cleaningConfirmation.create({ data: { reservationId: ctx.reservation.id, propertyId: ctx.reservation.propertyId, staffMemberId: candidate.staffMemberId, token: randomBytes(32).toString("hex"), status: "PENDING" } });
    return { nextConfirmationId: offer.id, recovery: "BACKUP_OFFER_PENDING" as const };
  }
  return { nextConfirmationId: null, recovery: "NO_VIABLE_BACKUP" as const };
}
/** Autonomous handoff after an explicit incomplete declaration. Recording the
 * declaration itself still never closes work. No backup is marked accepted. */
export async function offerBackupForIncompleteCleaning(db: PrismaClient,
  scope: Scope & { reportId: string }, now = new Date()) {
  return atomic(db, async tx => {
    const ctx = await context(tx, scope);
    await tx.$queryRaw`SELECT "id" FROM "Property" WHERE "id" = ${ctx.reservation.propertyId} FOR UPDATE`;
    if (!await cleaningPinAIRecoveryAllowed(tx, { propertyId: ctx.reservation.propertyId, organizationId: scope.organizationId }, now)) throw new CleaningReassignmentError("CLEANING_RECOVERY_PIN_AI_NOT_AUTHORIZED");
    const report = await tx.cleaningWorkIssueReport.findUnique({ where: { id: scope.reportId }, include: { work: true } });
    if (!report || report.kind !== "INCOMPLETE" || report.work.confirmationId !== ctx.offer.id || report.work.staffMemberId !== scope.staffMemberId) throw new CleaningReassignmentError("CLEANING_RECOVERY_REPORT_INVALID");
    if (report.work.supersededAt && ctx.offer.status === "REASSIGNED") return { replayed: true, nextConfirmationId: null, recovery: "ALREADY_RECORDED" as const };
    const latest = await tx.cleaningWorkIssueReport.findFirst({ where: { cleaningWorkId: report.cleaningWorkId }, orderBy: [{ reportedAt: "desc" }, { id: "desc" }] });
    if (latest?.id !== report.id || ctx.offer.status !== "CONFIRMED" ||
        (await assessLatestCleaningIssue(tx, report.work, now))?.decision !== "BACKUP_REVIEW_REQUIRED") throw new CleaningReassignmentError("CLEANING_RECOVERY_CONTEXT_CHANGED");
    await tx.cleaningConfirmation.update({ where: { id: ctx.offer.id }, data: { status: "REASSIGNED" } });
    const replacement = await nextOffer(tx, ctx, now, true);
    if (!replacement.nextConfirmationId) {
      // Preserve the current work when nobody can take over; host intervention
      // owns this report. Do not manufacture a cancellation or completion.
      await tx.cleaningConfirmation.update({ where: { id: ctx.offer.id }, data: { status: "CONFIRMED" } });
      return { replayed: false, ...replacement };
    }
    await tx.cleaningWork.update({ where: { id: report.cleaningWorkId }, data: { supersededAt: now } });
    return { replayed: false, ...replacement };
  });
}
/** Explicit withdrawal only; missing start/completion never calls this service.
 * Only never-programmed entry intent is closed; no physical provider writes. */
export async function withdrawCleaning(db: PrismaClient, scope: Scope, mode: "cancel" | "decline" | "expire", now = new Date()) {
  return atomic(db, async tx => {
    const ctx = await context(tx, scope);
    const terminal = mode === "cancel" ? "CANCELLED" : mode === "decline" ? "DECLINED" : "EXPIRED";
    if (ctx.offer.status === terminal) return { replayed: true, nextConfirmationId: null, recovery: "ALREADY_RECORDED" as const };
    if (ctx.offer.status !== (mode === "cancel" ? "CONFIRMED" : "PENDING")) throw new CleaningReassignmentError("CLEANING_OFFER_NOT_ACTIONABLE");
    const works = await tx.cleaningWork.findMany({ where: { reservationId: ctx.reservation.id, cancelledAt: null, supersededAt: null } });
    if (works.some(w => w.startConfirmedAt || w.completionConfirmedAt || w.confirmationId !== ctx.offer.id)) throw new CleaningReassignmentError("CLEANING_ALREADY_STARTED_OR_CHANGED");
    // Cancellation closes at the current canonical window start even if the
    // cleaner has not pressed Start. Re-read under the reservation lock so a
    // changed checkout/cleaning window cannot leave an obsolete deadline.
    if (mode === "cancel" && now >= (await schedule(tx, ctx, now)).startsAt) {
      throw new CleaningReassignmentError("CLEANING_CANCELLATION_WINDOW_CLOSED");
    }
    await tx.cleaningConfirmation.update({ where: { id: ctx.offer.id }, data: { status: terminal } });
    await resolveDeferredCleaningOfferAttention(tx, ctx.offer.id, now);
    await tx.cleaningWork.updateMany({ where: { confirmationId: ctx.offer.id, cancelledAt: null, supersededAt: null }, data: { cancelledAt: now } });
    if (mode === "cancel") {
      const cleaner = await tx.staffMember.findUnique({ where: { id: scope.staffMemberId }, select: { ttlockCardRef: true } });
      const label = String(cleaner?.ttlockCardRef ?? "").trim();
      const card = label && await tx.nfcCard.findFirst({ where: { propertyId: ctx.offer.propertyId, label }, select: { id: true } });
      if (card) {
        // Competes atomically with the worker claim. Programming evidence or
        // any previous attempt prevents treating a grant as unused.
        const closed = await tx.nfcAssignment.updateMany({ where: {
          reservationId: ctx.reservation.id, nfcCardId: card.id, role: "CLEANING",
          status: "SCHEDULED", retryCount: 0, provisioningStartedAt: null,
          provisionedAt: null, cleanerProgrammingAttempts: { none: {} },
        }, data: { status: "ENDED", lastError: "CLEANER_UNUSED_GRANT_CANCELLED" } });
        if (closed.count > 0) await tx.staffAssignment.updateMany({ where: {
          reservationId: ctx.reservation.id, staffMemberId: scope.staffMemberId,
          status: "SCHEDULED",
        }, data: { status: "CANCELLED", lastError: "CLEANER_UNUSED_GRANT_CANCELLED" } });
      }
    }
    const replacement = await nextOffer(tx, ctx, now);
    if (replacement.recovery === "NO_VIABLE_BACKUP") {
      await recordCleaningBackupExhaustion(tx, { ...attentionContext(ctx, now), confirmationId: ctx.offer.id });
    } else {
      await resolveWithdrawnCleaningOfferAttention(tx, { ...attentionContext(ctx, now), replacementAccepted: false });
    }
    return { replayed: false, ...replacement };
  });
}
/** Availability acceptance only; timing consent/start remain separate explicit actions. */
export async function acceptCleaningOffer(db: PrismaClient, scope: Scope, now = new Date()) {
  return atomic(db, async tx => {
    // Serialize acceptance for the same cleaner across different properties.
    await tx.$queryRaw`SELECT "id" FROM "StaffMember" WHERE "id" = ${scope.staffMemberId} FOR UPDATE`;
    const ctx = await context(tx, scope);
    if (ctx.offer.status === "CONFIRMED") return { replayed: true };
    if (ctx.offer.status !== "PENDING") throw new CleaningReassignmentError("CLEANING_OFFER_NOT_ACTIONABLE");
    const sent = await tx.messageLog.findFirst({ where: { reservationId: ctx.reservation.id, propertyId: ctx.offer.propertyId, channel: "sms", provider: "twilio", status: "SENT", body: { contains: ctx.offer.token } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
    if (sent && now.getTime() >= sent.createdAt.getTime() + 120 * 60000) throw new CleaningReassignmentError("CLEANING_OFFER_RESPONSE_EXPIRED");
    if (await tx.cleaningConfirmation.findFirst({ where: { reservationId: ctx.reservation.id, id: { not: ctx.offer.id }, status: { in: ["PENDING", "CONFIRMED"] } } })) throw new CleaningReassignmentError("CLEANING_OTHER_OFFER_ACTIVE");
    if (await tx.cleaningWork.findFirst({ where: { reservationId: ctx.reservation.id, cancelledAt: null, supersededAt: null } })) throw new CleaningReassignmentError("CLEANING_OTHER_WORK_ACTIVE");
    const assignment = await tx.propertyStaff.findUniqueOrThrow({ where: { propertyId_staffMemberId: { propertyId: ctx.offer.propertyId, staffMemberId: scope.staffMemberId } } });
    const bounds = await schedule(tx, ctx, now);
    if (!await viable(tx, ctx, assignment, bounds)) throw new CleaningReassignmentError("CLEANING_SCHEDULE_NOT_VIABLE");
    const recoveryHandoff = await tx.cleaningConfirmation.findFirst({ where: { reservationId: ctx.reservation.id, status: "REASSIGNED" } });
    if (recoveryHandoff &&
        bounds.earliestActualStart.getTime() + assignment.cleaningDurationCommitmentMinutes! * 60000 >= bounds.endsAt.getTime()) throw new CleaningReassignmentError("CLEANING_SCHEDULE_NOT_VIABLE");
    if (![assignment.cleaningStartConfirmationGraceMinutes, assignment.cleaningFollowupGraceMinutes].every(v => Number.isInteger(v) && v >= 5 && v <= 240)) throw new CleaningReassignmentError("CLEANING_TIMING_NOT_CONFIGURED");
    await tx.cleaningConfirmation.update({ where: { id: ctx.offer.id }, data: { status: "CONFIRMED", updatedAt: now } });
    await resolveDeferredCleaningOfferAttention(tx, ctx.offer.id, now);
    await tx.cleaningWork.create({ data: { reservationId: ctx.reservation.id, propertyId: ctx.offer.propertyId, staffMemberId: scope.staffMemberId, confirmationId: ctx.offer.id, scheduledStartAt: recoveryHandoff ? bounds.earliestActualStart : bounds.startsAt, durationCommitmentMinutes: assignment.cleaningDurationCommitmentMinutes!, startConfirmationGraceMinutes: assignment.cleaningStartConfirmationGraceMinutes, followupGraceMinutes: assignment.cleaningFollowupGraceMinutes } });
    await resolveWithdrawnCleaningOfferAttention(tx, { ...attentionContext(ctx, now), replacementAccepted: true });
    return { replayed: false };
  });
}
