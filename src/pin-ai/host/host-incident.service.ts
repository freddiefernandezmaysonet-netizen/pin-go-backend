import type { Prisma, PrismaClient } from "@prisma/client";
import { upsertOperationalIssue } from "../../apms/operational-intelligence.service.js";
import { guestIncidentRecipientWhere } from "../guest/guest-incident-recipient-policy.js";
import { commandHash, fail, hostScopeEnabled, openHostContent, parseHostCommand, sealHostContent, type HostEnvironment } from "./host-incident-policy.js";

type Actor = { id: string; orgId: string };
type Tx = Prisma.TransactionClient;
type Input = { prisma: PrismaClient; actor: Actor; env: HostEnvironment };
async function authorize(tx: Tx, actor: Actor) {
  if (!actor?.id || !actor.orgId) return fail(401, "UNAUTHENTICATED");
  const user = await tx.dashboardUser.findFirst({ where: { id: actor.id, ...guestIncidentRecipientWhere(actor.orgId) }, select: { id: true } });
  if (!user) return fail(403, "HOST_ACCESS_DENIED");
}
function reference(issue: { metadata: Prisma.JsonValue | null }) {
  const ref = (issue.metadata as Record<string, unknown> | null)?.reference;
  if (typeof ref !== "string" || !/^GI-[A-F0-9]{12}$/.test(ref)) return fail(404, "NOT_FOUND");
  return ref;
}
async function scopedIssue(tx: Tx, input: Input, ref: string) {
  await authorize(tx, input.actor);
  if (!/^GI-[A-F0-9]{12}$/.test(ref)) return fail(404, "NOT_FOUND");
  const issue = await tx.operationalIssue.findFirst({ where: { organizationId: input.actor.orgId,
    engine: "PIN_AI_GUEST_INCIDENT", visibility: "HOST", metadata: { path: ["reference"], equals: ref } } });
  if (!issue?.propertyId || !issue.reservationId || !hostScopeEnabled(input.env, input.actor.orgId, issue.reservationId)) return fail(404, "NOT_FOUND");
  const reservation = await tx.reservation.findFirst({ where: { id: issue.reservationId, propertyId: issue.propertyId,
    property: { organizationId: input.actor.orgId } }, select: { reservationNumber: true, property: { select: { name: true } } } });
  if (!reservation) return fail(404, "NOT_FOUND");
  return { issue, reservation };
}
export async function listHostIncidents(input: Input & { before?: string }) {
  return input.prisma.$transaction(async tx => {
    await authorize(tx, input.actor);
    const { parsePinAIActionCanaryReservationIds } = await import("../actions/action-canary-scope.js");
    const ids = [...parsePinAIActionCanaryReservationIds(input.env.PIN_AI_HOST_INCIDENT_RESERVATION_IDS).ids]
      .filter(id => hostScopeEnabled(input.env, input.actor.orgId, id));
    if (!ids.length) return fail(404, "NOT_FOUND");
    const rows = await tx.operationalIssue.findMany({ where: { organizationId: input.actor.orgId,
      engine: "PIN_AI_GUEST_INCIDENT", visibility: "HOST", reservationId: { in: ids },
      ...(input.before ? { id: { lt: input.before } } : {}) }, orderBy: { id: "desc" }, take: 51 });
    const items = [];
    for (const row of rows.slice(0, 50)) {
      const scoped = await scopedIssue(tx, input, reference(row));
      items.push({ reference: reference(row), state: row.workflowState, propertyName: scoped.reservation.property.name,
        reservationNumber: scoped.reservation.reservationNumber });
    }
    return { items, nextCursor: rows.length > 50 ? rows[49].id : null };
  });
}
export async function readHostIncident(input: Input & { reference: string; after?: number }) {
  return input.prisma.$transaction(async tx => {
    const { issue, reservation } = await scopedIssue(tx, input, input.reference);
    const thread = await tx.pinAIHostIncidentThread.findUnique({ where: { issueId: issue.id } });
    if (thread && (thread.organizationId !== input.actor.orgId || thread.propertyId !== issue.propertyId || thread.reservationId !== issue.reservationId)) return fail(404, "NOT_FOUND");
    const rows = thread ? await tx.pinAIHostIncidentMessage.findMany({ where: { threadId: thread.id,
      sequence: { gt: input.after ?? 0 } }, orderBy: { sequence: "asc" }, take: 100 }) : [];
    return { reference: reference(issue), state: issue.workflowState, reportedFacts: issue.issue,
      reservationNumber: reservation.reservationNumber, propertyName: reservation.property.name,
      version: thread?.version ?? 0, acknowledgedAt: thread?.acknowledgedAt ?? null,
      messages: rows.map(m => ({ id: m.id, sequence: m.sequence, actorId: m.actorId, kind: m.kind,
        audience: m.audience, createdAt: m.createdAt,
        text: openHostContent(input.env, `${input.actor.orgId}:${m.threadId}:${m.sequence}:${m.audience}`, m.contentCiphertext) })),
      nextAfter: rows.length === 100 ? rows[99].sequence : null };
  });
}
export async function applyHostIncidentCommand(input: Input & { reference: string; command: unknown }) {
  const command = parseHostCommand(input.command);
  return input.prisma.$transaction(async tx => {
    const { issue: initial } = await scopedIssue(tx, input, input.reference);
    // Same lock ordering as guest REPORT and canonical upsert; serialize all
    // writers, including closure and recurrence, against the selected issue.
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", initial.operationalKey);
    await tx.$queryRawUnsafe('SELECT "id" FROM "OperationalIssue" WHERE "id" = $1 FOR UPDATE', initial.id);
    const { issue } = await scopedIssue(tx, input, input.reference);
    const thread = await tx.pinAIHostIncidentThread.upsert({ where: { issueId: issue.id }, update: {}, create: {
      issueId: issue.id, organizationId: input.actor.orgId, propertyId: issue.propertyId!, reservationId: issue.reservationId!,
    } });
    if (thread.organizationId !== input.actor.orgId || thread.propertyId !== issue.propertyId || thread.reservationId !== issue.reservationId) return fail(404, "NOT_FOUND");
    const hash = commandHash(input.actor.id, command);
    const prior = await tx.pinAIHostIncidentMessage.findUnique({ where: { threadId_requestId: { threadId: thread.id, requestId: command.requestId } } });
    if (prior) {
      if (prior.requestHash !== hash) return fail(409, "REQUEST_ID_REUSED");
      return { reference: input.reference, eventId: prior.id, version: prior.sequence, operation: prior.kind, replayed: true };
    }
    if (thread.version !== command.expectedVersion) return fail(409, "VERSION_CONFLICT");
    if (issue.workflowState === "RESOLVED") return fail(409, "INCIDENT_RESOLVED");
    if (command.operation === "ACKNOWLEDGE" && thread.acknowledgedAt) return fail(409, "ALREADY_ACKNOWLEDGED");
    const sequence = thread.version + 1, audience = command.operation === "PUBLISH" ? "GUEST" : "INTERNAL";
    const event = await tx.pinAIHostIncidentMessage.create({ data: { threadId: thread.id, sequence,
      actorId: input.actor.id, requestId: command.requestId, requestHash: hash, kind: command.operation, audience,
      contentCiphertext: sealHostContent(input.env, `${input.actor.orgId}:${thread.id}:${sequence}:${audience}`, command.text) } });
    await tx.pinAIHostIncidentThread.update({ where: { id: thread.id }, data: { version: sequence,
      ...(command.operation === "ACKNOWLEDGE" ? { acknowledgedBy: input.actor.id, acknowledgedAt: event.createdAt } : {}) } });
    const metadata = { ...(issue.metadata as Record<string, unknown>), lastHostEventId: event.id, lastHostActorId: input.actor.id };
    if (command.operation === "RESOLVE") {
      // Outcome text remains encrypted and internal. Canonical guest status may
      // expose resolution, but must not expose this note or imply physical proof.
      await upsertOperationalIssue(tx, { operationalKey: issue.operationalKey, issueCode: issue.issueCode,
        engine: issue.engine, title: issue.title, issue: issue.issue, severity: issue.severity,
        workflowState: "RESOLVED", visibility: "HOST", responsibleActor: "HOST", actionRequired: false,
        canAutoResolve: false, autoResolveStatus: "NOT_SUPPORTED", actionTarget: issue.actionTarget,
        organizationId: issue.organizationId, propertyId: issue.propertyId, reservationId: issue.reservationId,
        sourceType: "MANUAL", resolutionType: "MANUAL", resolvedBy: "HOST", resolvedAt: event.createdAt,
        resolutionCode: "HOST_REPORTED_RESOLVED", resolutionSummary: "Host marked the incident resolved; physical repair not independently verified.",
        transitionCode: "HOST_INCIDENT_RESOLVED", transitionSummary: "Authenticated host recorded resolution.",
        transitionedBy: "HOST", metadata });
    } else {
      await tx.operationalIssueTransition.create({ data: { issueId: issue.id, operationalKey: issue.operationalKey,
        issueCode: issue.issueCode, fromWorkflowState: issue.workflowState, toWorkflowState: issue.workflowState,
        transitionCode: `HOST_INCIDENT_${command.operation}`, transitionSummary: "Authenticated host recorded a scoped incident action.",
        transitionedBy: "HOST", sourceType: "MANUAL", metadata: { actorId: input.actor.id, eventId: event.id } } });
    }
    return { reference: input.reference, eventId: event.id, version: sequence, operation: command.operation, replayed: false };
  });
}

// Separate guest projection: incident status is canonical and independent
// from optional host-published messages. Never expose internal content.
export async function readPublishedIncidentUpdates(input: { prisma: PrismaClient; env: HostEnvironment; guestToken: string; after?: string }) {
  const reservation = await input.prisma.reservation.findFirst({ where: { guestToken: input.guestToken,
    guestTokenExpiresAt: { gt: new Date() }, status: "ACTIVE", property: { status: "ACTIVE" } },
    select: { id: true, propertyId: true, property: { select: { organizationId: true } } } });
  if (!reservation || !hostScopeEnabled(input.env, reservation.property.organizationId, reservation.id)) return fail(404, "NOT_FOUND");
  const issueWhere = { organizationId: reservation.property.organizationId, reservationId: reservation.id,
    propertyId: reservation.propertyId, engine: "PIN_AI_GUEST_INCIDENT", visibility: "HOST" } as const;
  const issues = await input.prisma.operationalIssue.findMany({ where: issueWhere,
    include: { hostThread: { select: { acknowledgedAt: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const rows = await input.prisma.pinAIHostIncidentMessage.findMany({ where: { audience: "GUEST", kind: "PUBLISH",
    ...(input.after ? { id: { gt: input.after } } : {}), thread: { organizationId: reservation.property.organizationId,
      reservationId: reservation.id, propertyId: reservation.propertyId, issue: issueWhere } },
    include: { thread: { include: { issue: true } } }, orderBy: { id: "asc" }, take: 100 });
  return {
    incidents: issues.map(issue => ({ reference: reference(issue), createdAt: issue.createdAt,
      resolution: issue.workflowState === "RESOLVED" ? "RESOLVED" as const : "OPEN" as const,
      hostAcknowledged: issue.hostThread?.acknowledgedAt != null })),
    updates: rows.map(m => ({ id: m.id, reference: reference(m.thread.issue), createdAt: m.createdAt,
      text: openHostContent(input.env, `${m.thread.organizationId}:${m.threadId}:${m.sequence}:GUEST`, m.contentCiphertext) })),
    nextAfter: rows.length === 100 ? rows[99].id : null,
  };
}
