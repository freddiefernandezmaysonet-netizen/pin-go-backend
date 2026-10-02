import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { upsertOperationalIssue } from "../apms/operational-intelligence.service";
import { checkPropertyAvailability } from "./availability.service";

type Actor = { id: string; orgId: string };
type Tx = Prisma.TransactionClient;
export class AvailabilityConflictReviewError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const fail = (status: number, code: string): never => { throw new AvailabilityConflictReviewError(status, code); };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const date = (value: unknown) => {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const result = new Date(value);
  return Number.isFinite(result.getTime()) ? result.toISOString() : null;
};
export function parseAvailabilityConflictResolution(value: unknown) {
  const input = object(value);
  if (Object.keys(input).some(key => !["expectedUpdatedAt", "resolutionSummary"].includes(key)) ||
      typeof input.expectedUpdatedAt !== "string" || date(input.expectedUpdatedAt) !== input.expectedUpdatedAt ||
      typeof input.resolutionSummary !== "string" || !input.resolutionSummary.trim() || input.resolutionSummary.length > 2000) {
    return fail(400, "INVALID_CONFLICT_RESOLUTION");
  }
  return { expectedUpdatedAt: input.expectedUpdatedAt, resolutionSummary: input.resolutionSummary.trim() };
}
async function authorize(tx: Tx, actor: Actor) {
  if (!actor?.id || !actor.orgId) return fail(401, "UNAUTHENTICATED");
  const user = await tx.dashboardUser.findFirst({ where: { id: actor.id, organizationId: actor.orgId,
    isActive: true, role: { in: ["ORG_ADMIN", "ADMIN", "PLATFORM_ADMIN"] } }, select: { id: true } });
  if (!user) return fail(403, "CONFLICT_REVIEW_FORBIDDEN");
}
async function scopedReservation(tx: Tx, actor: Actor, reservationId: string) {
  const reservation = await tx.reservation.findFirst({ where: { id: reservationId,
    externalProvider: "CHANNEX", property: { organizationId: actor.orgId, status: "ACTIVE" } },
    select: { id: true, reservationNumber: true, guestName: true, checkIn: true, checkOut: true,
      status: true, propertyId: true, property: { select: { name: true, timezone: true } } } });
  if (!reservation) return fail(404, "CONFLICT_REVIEW_NOT_FOUND");
  return reservation;
}
const issueScope = (actor: Actor) => ({ organizationId: actor.orgId, issueCode: "CHANNEX_AVAILABILITY_CONFLICT",
  engine: "Reservation", visibility: "HOST" as const, metadata: { path: ["version"], equals: "channex_availability_conflict_v1" } });

/** Project only whitelisted facts; every linked entity is re-scoped to the property. */
async function projectCause(tx: Tx, propertyId: string, value: unknown) {
  const cause = object(value);
  const type = String(cause.type ?? "UNKNOWN");
  let reservationId: string | null = null;
  if (type === "RESERVATION" && typeof cause.id === "string") reservationId = cause.id;
  if (["RESERVATION_MODIFICATION_HOLD", "STAY_TIME_TURNOVER_HOLD"].includes(type) && typeof cause.id === "string") {
    const modification = await tx.reservationModification.findFirst({ where: { id: cause.id, reservation: { propertyId } },
      select: { reservationId: true } });
    reservationId = modification?.reservationId ?? null;
  }
  const reservation = reservationId ? await tx.reservation.findFirst({ where: { id: reservationId, propertyId },
    select: { id: true, reservationNumber: true, guestName: true } }) : null;
  // Block reasons are not arbitrary metadata: read them only from a scoped live block.
  const block = type === "BLOCKED_DATE" && typeof cause.id === "string"
    ? await tx.propertyBlockedDate.findFirst({ where: { id: cause.id, propertyId }, select: { reason: true } }) : null;
  const labels: Record<string, string> = { RESERVATION: "Reservation overlap",
    RESERVATION_MODIFICATION_HOLD: "Pending reservation change", STAY_TIME_TURNOVER_HOLD: "Protected cleaning interval",
    BLOCKED_DATE: "Blocked dates" };
  return { type, label: labels[type] ?? "Availability requires review", reservation,
    startsAt: date(cause.checkIn ?? cause.proposedCheckIn ?? cause.startsAt ?? cause.startDate),
    endsAt: date(cause.checkOut ?? cause.proposedCheckOut ?? cause.endsAt ?? cause.endDate),
    blockReason: block?.reason ?? null };
}
export async function readAvailabilityConflictReview(db: PrismaClient, actor: Actor, reservationId: string) {
  return db.$transaction(async tx => {
    await authorize(tx, actor);
    const reservation = await scopedReservation(tx, actor, reservationId);
    const issues = await tx.operationalIssue.findMany({ where: { ...issueScope(actor), reservationId,
      propertyId: reservation.propertyId }, orderBy: [{ firstDetectedAt: "desc" }, { id: "desc" }], take: 51 });
    const availability = reservation.status === "ACTIVE" ? await checkPropertyAvailability({ propertyId: reservation.propertyId,
      checkIn: reservation.checkIn, checkOut: reservation.checkOut, excludeReservationId: reservation.id }, tx) : null;
    const items = [];
    for (const issue of issues.slice(0, 50)) {
      const transitions = await tx.operationalIssueTransition.findMany({ where: { issueId: issue.id },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take: 100,
        select: { toWorkflowState: true, transitionSummary: true, transitionedBy: true, occurredAt: true } });
      items.push({ id: issue.id, updatedAt: issue.updatedAt.toISOString(), state: issue.workflowState,
        incomingStartsAt: date(object(issue.metadata).incomingCheckIn), incomingEndsAt: date(object(issue.metadata).incomingCheckOut),
        detectedAt: issue.firstDetectedAt.toISOString(), detectedCause: await projectCause(tx, reservation.propertyId, object(issue.metadata).conflict),
        resolutionSummary: issue.resolutionSummary, resolvedAt: issue.resolvedAt?.toISOString() ?? null,
        history: transitions.map(row => ({ state: row.toWorkflowState, summary: row.transitionSummary,
          actor: row.transitionedBy, at: row.occurredAt.toISOString() })) });
    }
    return { reservation, items, hasMore: issues.length > 50,
      currentAvailability: availability ? { available: availability.available,
        cause: availability.available ? null : await projectCause(tx, reservation.propertyId, availability.conflict) } : null,
      resolutionMeaning: "HOST_REPORTED_RESOLVED" as const };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
export async function resolveAvailabilityConflictReview(db: PrismaClient, actor: Actor, issueId: string, value: unknown) {
  const command = parseAvailabilityConflictResolution(value);
  const hash = createHash("sha256").update(JSON.stringify({ actorId: actor.id, ...command })).digest("hex");
  return db.$transaction(async tx => {
    await authorize(tx, actor);
    const initial = await tx.operationalIssue.findFirst({ where: { id: issueId, ...issueScope(actor) } });
    if (!initial?.reservationId || !initial.propertyId) return fail(404, "CONFLICT_REVIEW_NOT_FOUND");
    // Same lock order as canonical issue upserts; serialize closure, replay and cancellation.
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", initial.operationalKey);
    await authorize(tx, actor);
    const issue = await tx.operationalIssue.findFirst({ where: { id: issueId, ...issueScope(actor) } });
    if (!issue?.reservationId || !issue.propertyId) return fail(404, "CONFLICT_REVIEW_NOT_FOUND");
    const reservation = await scopedReservation(tx, actor, issue.reservationId);
    if (reservation.propertyId !== issue.propertyId) return fail(404, "CONFLICT_REVIEW_NOT_FOUND");
    const metadata = object(issue.metadata);
    if (issue.workflowState === "RESOLVED") {
      if (object(metadata.hostResolution).commandHash === hash) return { state: "RESOLVED" as const, replayed: true };
      return fail(409, "CONFLICT_ALREADY_RESOLVED");
    }
    if (issue.workflowState !== "ACTION_REQUIRED" || issue.responsibleActor !== "HOST" ||
        !issue.actionRequired || issue.updatedAt.toISOString() !== command.expectedUpdatedAt) return fail(409, "CONFLICT_REVIEW_STALE");
    await upsertOperationalIssue(tx, { operationalKey: issue.operationalKey, issueCode: issue.issueCode,
      engine: issue.engine, title: issue.title, issue: issue.issue, operationalImpact: issue.operationalImpact,
      recommendedAction: issue.recommendedAction, nextAutomaticStep: null, severity: issue.severity,
      workflowState: "RESOLVED", visibility: "HOST", responsibleActor: "HOST", actionRequired: false,
      canAutoResolve: false, autoResolveStatus: "NOT_SUPPORTED", actionTarget: issue.actionTarget,
      organizationId: actor.orgId, propertyId: issue.propertyId, reservationId: issue.reservationId,
      guestName: issue.guestName, sourceType: "MANUAL", resolutionType: "MANUAL", resolvedBy: "HOST",
      resolutionCode: "HOST_REPORTED_RESOLVED", resolutionSummary: command.resolutionSummary,
      transitionCode: "OTA_AVAILABILITY_CONFLICT_HOST_RESOLVED", transitionSummary: command.resolutionSummary,
      transitionedBy: "HOST", metadata: { ...metadata, hostResolution: { actorId: actor.id, commandHash: hash,
        independentlyVerified: false, reservationChanged: false } } });
    return { state: "RESOLVED" as const, replayed: false };
  });
}
