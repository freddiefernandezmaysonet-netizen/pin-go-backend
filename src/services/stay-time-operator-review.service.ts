import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { isStayTimeModification } from "./stay-time-apply-validation.service.js";

type Actor = { id: string; orgId: string; role?: string };
type Tx = Prisma.TransactionClient;
const CODE = "STAY_TIME_RECOVERY_REVIEW";
const scope = { issueCode: CODE, visibility: "DEVELOPER" as const, responsibleActor: "PIN_GO" as const,
  metadata: { path: ["version"], equals: "stay_time_recovery_review_v1" } };
export class StayTimeOperatorReviewError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const fail = (status: number, code: string): never => { throw new StayTimeOperatorReviewError(status, code); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) return fail(400, "INVALID_REVIEW_REQUEST");
  return value;
}
async function authorize(tx: Tx, actor: Actor) {
  if (!actor?.id || !actor.orgId || actor.role !== "PLATFORM_ADMIN") return fail(403, "PLATFORM_ADMIN_REQUIRED");
  const admin = await tx.dashboardUser.findFirst({ where: { id: actor.id, organizationId: actor.orgId,
    role: "PLATFORM_ADMIN", isActive: true }, select: { id: true } });
  if (!admin) return fail(403, "PLATFORM_ADMIN_REQUIRED");
}
async function readItem(tx: Tx, issueId: string) {
  const issue = await tx.operationalIssue.findFirst({ where: { id: issueId, ...scope } });
  if (!issue || !issue.operationalKey.startsWith(`${CODE}:`)) return fail(404, "RECOVERY_REVIEW_NOT_FOUND");
  const modificationId = issue.operationalKey.slice(CODE.length + 1);
  const m = await tx.reservationModification.findFirst({ where: { id: modificationId,
    reservationId: issue.reservationId ?? "", requestSource: "PIN_AI_GUEST_SERVICES",
    reservation: { propertyId: issue.propertyId ?? "", property: { organizationId: issue.organizationId ?? "" } } },
    select: { id: true, status: true, guestConfirmation: true, stripePaymentStatus: true, additionalChargeAmount: true,
      currency: true, failureCode: true, stayTimeReconciledAt: true, stayTimeRecoveryAttempts: true, stayTimeRecoveryNextAt: true,
      reservation: { select: { reservationNumber: true, property: { select: { name: true, timezone: true,
        organization: { select: { name: true } } } } } } } });
  if (!m || !isStayTimeModification(m.guestConfirmation)) return fail(404, "RECOVERY_REVIEW_NOT_FOUND");
  const rawOperation = object(m.guestConfirmation).operation;
  const operation = rawOperation === "EARLY_CHECKIN" || rawOperation === "LATE_CHECKOUT" ? rawOperation : "SCHEDULE_CHANGE";
  // An explicit projection: never return provider references, tokens, Checkout
  // URLs, pricing snapshots, raw errors or arbitrary issue metadata.
  return { issue, item: { id: issue.id, updatedAt: issue.updatedAt.toISOString(), state: issue.workflowState,
    detectedAt: issue.firstDetectedAt.toISOString(), organization: m.reservation.property.organization.name,
    property: m.reservation.property.name, timezone: m.reservation.property.timezone,
    reservationNumber: m.reservation.reservationNumber, operation, modificationStatus: m.status,
    paymentEvidence: m.failureCode === "STAY_TIME_REFUNDED" ? "REFUNDED" : m.stripePaymentStatus === "paid" ? "PAID" : "UNVERIFIED",
    additionalChargeAmount: String(m.additionalChargeAmount), currency: m.currency,
    attempts: m.stayTimeRecoveryAttempts, nextAttemptAt: m.stayTimeRecoveryNextAt?.toISOString() ?? null,
    reconciliationCompleted: m.stayTimeReconciledAt !== null, physicalAccessCertified: false as const } };
}
export async function listStayTimeOperatorReviews(db: PrismaClient, actor: Actor, query: Record<string, unknown>) {
  if (Object.keys(query).some(k => !["state", "after"].includes(k)) ||
      (query.state !== undefined && !["OPEN", "RESOLVED"].includes(String(query.state)))) fail(400, "INVALID_REVIEW_REQUEST");
  const after = query.after === undefined ? undefined : identifier(query.after);
  return db.$transaction(async tx => {
    await authorize(tx, actor);
    const rows = await tx.operationalIssue.findMany({ where: { ...scope,
      workflowState: query.state === "RESOLVED" ? "RESOLVED" : { not: "RESOLVED" }, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: "asc" }, take: 26, select: { id: true } });
    const items = [];
    for (const row of rows.slice(0, 25)) {
      try { items.push((await readItem(tx, row.id)).item); }
      catch (error) { if (!(error instanceof StayTimeOperatorReviewError && error.status === 404)) throw error; }
    }
    return { items, nextCursor: rows.length > 25 ? rows[24].id : null };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
export async function readStayTimeOperatorReview(db: PrismaClient, actor: Actor, issueId: string) {
  identifier(issueId);
  return db.$transaction(async tx => {
    await authorize(tx, actor);
    const { item } = await readItem(tx, issueId);
    const history = await tx.operationalIssueTransition.findMany({ where: { issueId },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 51,
      select: { id: true, occurredAt: true, transitionCode: true, transitionSummary: true, toWorkflowState: true } });
    return { item, history: history.slice(0, 50).map(h => ({ id: h.id, at: h.occurredAt.toISOString(),
      kind: h.transitionCode === "STAY_TIME_OPERATOR_REVIEWED" ? "OPERATOR_REVIEW" : "RECOVERY_STATE",
      note: h.transitionCode === "STAY_TIME_OPERATOR_REVIEWED" ? h.transitionSummary : null, state: h.toWorkflowState })),
    historyHasMore: history.length > 50 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
export function parseStayTimeOperatorReview(value: unknown) {
  const input = object(value);
  if (Object.keys(input).some(k => !["requestId", "expectedUpdatedAt", "note"].includes(k)) ||
      typeof input.note !== "string" || !input.note.trim() || input.note.length > 2000 ||
      typeof input.expectedUpdatedAt !== "string" || !Number.isFinite(Date.parse(input.expectedUpdatedAt)) ||
      new Date(input.expectedUpdatedAt).toISOString() !== input.expectedUpdatedAt) return fail(400, "INVALID_REVIEW_REQUEST");
  return { requestId: identifier(input.requestId), expectedUpdatedAt: input.expectedUpdatedAt, note: input.note.trim() };
}
export async function recordStayTimeOperatorReview(db: PrismaClient, actor: Actor, issueId: string, value: unknown) {
  identifier(issueId);
  const command = parseStayTimeOperatorReview(value);
  const hash = createHash("sha256").update(JSON.stringify({ issueId, actorId: actor.id, ...command })).digest("hex");
  return db.$transaction(async tx => {
    await authorize(tx, actor);
    const initial = await tx.operationalIssue.findFirst({ where: { id: issueId, ...scope }, select: { operationalKey: true } });
    if (!initial) return fail(404, "RECOVERY_REVIEW_NOT_FOUND");
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", initial.operationalKey);
    await authorize(tx, actor);
    const { issue } = await readItem(tx, issueId);
    const prior = await tx.operationalIssueTransition.findFirst({ where: { issueId, transitionCode: "STAY_TIME_OPERATOR_REVIEWED",
      AND: [{ metadata: { path: ["actorId"], equals: actor.id } }, { metadata: { path: ["requestId"], equals: command.requestId } }] } });
    if (prior) {
      if (object(prior.metadata).commandHash !== hash) return fail(409, "REVIEW_REQUEST_CONFLICT");
      return { recorded: true, replayed: true, resolved: false };
    }
    if (issue.workflowState !== "ACTION_REQUIRED" || issue.updatedAt.toISOString() !== command.expectedUpdatedAt)
      return fail(409, "RECOVERY_REVIEW_STALE");
    const at = new Date(Math.max(Date.now(), issue.updatedAt.getTime() + 1));
    await tx.operationalIssueTransition.create({ data: { issueId, operationalKey: issue.operationalKey, issueCode: CODE,
      fromWorkflowState: issue.workflowState, toWorkflowState: issue.workflowState, transitionCode: "STAY_TIME_OPERATOR_REVIEWED",
      transitionSummary: command.note, transitionedBy: "PIN_GO", sourceType: "MANUAL", occurredAt: at,
      metadata: { version: "stay_time_operator_review_v1", actorId: actor.id, requestId: command.requestId, commandHash: hash } } });
    await tx.operationalIssue.update({ where: { id: issueId }, data: { updatedAt: at } });
    return { recorded: true, replayed: false, resolved: false };
  });
}
