import { randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import { upsertOperationalIssue } from "../../apms/operational-intelligence.service.js";
import type { PinAIRuntimeRequest } from "../runtime/contracts.js";
import { readGuestMessages } from "./guest-history.js";
import { guestIncidentRecipientWhere } from "./guest-incident-recipient-policy.js";
import { GUEST_INCIDENT_NOTICE, guestIncidentEnabled, incidentNotificationState, parseIncidentInput,
  type GuestIncidentReceipt, type IncidentEnvironment } from "./guest-incident-policy.js";

export async function handleGuestIncident(input: {
  prisma: PrismaClient; request: PinAIRuntimeRequest; guestToken: string;
  args: Readonly<Record<string, unknown>>; env: IncidentEnvironment; now?: Date;
}): Promise<GuestIncidentReceipt | null> {
  const { prisma, request, guestToken, env } = input;
  const scope = request.context;
  if (!guestIncidentEnabled(scope.reservationId, env)) throw new Error("PIN_AI_INCIDENT_DISABLED");
  const command = parseIncidentInput(input.args);
  const now = input.now ?? new Date();
  return prisma.$transaction(async tx => {
    // Reauthorize the bearer token and canonical tenant on every read/write.
    const reservation = await tx.reservation.findFirst({ where: {
      id: scope.reservationId, propertyId: scope.propertyId, guestToken,
      guestTokenExpiresAt: { gt: now }, status: "ACTIVE", checkOut: { gt: now },
      property: { organizationId: scope.organizationId, status: "ACTIVE" },
    }, select: { id: true, reservationNumber: true, property: { select: { name: true } } } });
    if (!reservation) throw new Error("PIN_AI_INCIDENT_SCOPE_INVALID");
    const prefix = `PIN_AI_GUEST_INCIDENT:${scope.organizationId}:${scope.reservationId}:${command.category}:`;
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", prefix);
    let issue = await tx.operationalIssue.findFirst({ where: {
      organizationId: scope.organizationId, propertyId: scope.propertyId, reservationId: scope.reservationId,
      operationalKey: { startsWith: prefix }, engine: "PIN_AI_GUEST_INCIDENT",
    }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });

    if (issue && command.operation === "REPORT") {
      // Canonical host/reservation resolution does not use the category advisory
      // lock. Serialize against its row update before deciding update vs recurrence.
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", issue.operationalKey);
      await tx.$queryRawUnsafe('SELECT "id" FROM "OperationalIssue" WHERE "id" = $1 FOR UPDATE', issue.id);
      issue = await tx.operationalIssue.findUnique({ where: { id: issue.id } });
    }

    if (command.operation === "REPORT") {
      const history = await tx.pinAIGuestConversation.findUnique({ where: { reservationId: scope.reservationId },
        select: { guestHistoryCiphertext: true } });
      const guestTexts = [
        ...readGuestMessages({ reservationId: scope.reservationId, guestToken }, history?.guestHistoryCiphertext)
          .filter(m => m.role === "guest").slice(-10).map(m => m.text),
        ...request.conversation.filter(m => m.role === "guest").map(m => m.content),
      ];
      if (command.quotes.some(quote => !guestTexts.some(text => text.includes(quote)))) {
        throw new Error("PIN_AI_INCIDENT_UNSUPPORTED_GUEST_QUOTE");
      }
      const isNew = !issue || issue.workflowState === "RESOLVED";
      const prior = issue?.metadata as Record<string, unknown> | null;
      const reference = isNew ? `GI-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}` : String(prior?.reference);
      if (!/^GI-[A-F0-9]{12}$/.test(reference)) throw new Error("PIN_AI_INCIDENT_STORED_REFERENCE_INVALID");
      const quotes = [...new Set([...(isNew ? [] : (Array.isArray(prior?.quotes) ? prior.quotes as string[] : [])), ...command.quotes])].slice(-12);
      // REPORT after canonical resolution is an explicit recurrence; STATUS never reopens.
      const operationalKey = isNew ? `${prefix}${reference}` : issue!.operationalKey;
      issue = await upsertOperationalIssue(tx, {
        operationalKey, issueCode: "GUEST_REPORTED_INCIDENT", engine: "PIN_AI_GUEST_INCIDENT",
        title: `Guest incident / Incidente ${reference} — ${command.category}`,
        issue: `Guest-reported statements / Declaraciones del huésped (unverified / sin verificar):\n${quotes.join("\n")}`,
        recommendedAction: "Review the guest report, coordinate assistance, and record the verified outcome. / Revisar el reporte y registrar el resultado verificado.",
        nextAutomaticStep: "Track the queued host notice. A delivery failure does not resolve this incident.",
        severity: "WARNING", workflowState: "ACTION_REQUIRED", visibility: "HOST", responsibleActor: "HOST",
        actionRequired: true, canAutoResolve: false, autoResolveStatus: "NOT_SUPPORTED",
        organizationId: scope.organizationId, propertyId: scope.propertyId, reservationId: scope.reservationId,
        actionTarget: "RESERVATION", sourceType: "PIN_AI", transitionCode: "GUEST_INCIDENT_RECORDED",
        transitionSummary: "Guest report recorded; cause and resolution remain unverified.", transitionedBy: "GUEST",
        occurredAt: now, metadata: { reference, category: command.category, quotes, guestReported: true,
          diagnosisVerified: false, ...(isNew ? {} : { firstReportPreserved: true }) },
      });
      if (isNew) {
        // No fallback to arbitrary staff or a model-supplied destination.
        const admins = await tx.dashboardUser.findMany({
          where: guestIncidentRecipientWhere(scope.organizationId), select: { email: true },
        });
        const recipients = [...new Set(admins.map(a => a.email.trim().toLowerCase()).filter(Boolean))];
        for (const to of recipients) {
          await tx.messageLog.create({ data: {
            channel: "email", to, provider: "resend", status: "QUEUED", communicationType: GUEST_INCIDENT_NOTICE,
            organizationId: scope.organizationId, propertyId: scope.propertyId, reservationId: scope.reservationId,
            body: JSON.stringify({ kind: "PIN_GO_EMAIL_DELIVERY", type: GUEST_INCIDENT_NOTICE,
              retryPayload: { issueId: issue.id, reference, category: command.category,
                reservationNumber: reservation.reservationNumber, propertyName: reservation.property.name, quotes: command.quotes,
                dashboardOrigin: env.APP_URL ?? "" },
              nextAttemptAt: now.toISOString(), firstAttemptAt: null }),
          } });
        }
      }
    }
    if (!issue) return null;
    const notices = await tx.messageLog.findMany({ where: {
      organizationId: scope.organizationId, propertyId: scope.propertyId, reservationId: scope.reservationId,
      communicationType: GUEST_INCIDENT_NOTICE, body: { contains: `"issueId":"${issue.id}"` },
    }, select: { status: true, providerDeliveryStatus: true } });
    const metadata = issue.metadata as Prisma.JsonObject;
    const hostThread = await tx.pinAIHostIncidentThread.findFirst({ where: {
      issueId: issue.id, organizationId: scope.organizationId,
      propertyId: scope.propertyId, reservationId: scope.reservationId,
    }, select: { acknowledgedAt: true } });
    return { reference: String(metadata.reference), category: command.category, incidentRecorded: true,
      notification: incidentNotificationState(notices), resolution: issue.workflowState === "RESOLVED" ? "RESOLVED" : "OPEN",
      hostAcknowledged: hostThread?.acknowledgedAt != null };
  });
}
