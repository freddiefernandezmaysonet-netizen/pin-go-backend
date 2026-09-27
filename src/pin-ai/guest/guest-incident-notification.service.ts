import type { PrismaClient, MessageLog } from "@prisma/client";
import { sendGuestIncidentHostNotice } from "../../lib/mailer.js";
import type { GuestIncidentEmail } from "../../lib/email-templates/guestIncidentEmail.js";
import { GUEST_INCIDENT_NOTICE, guestIncidentEnabled, type IncidentEnvironment } from "./guest-incident-policy.js";
import { parsePinAIActionCanaryReservationIds } from "../actions/action-canary-scope.js";

const MAX_ATTEMPTS = 4;
const LEASE_MS = 90_000;
const REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;
type Envelope = {
  kind: string; type: string;
  retryPayload: { issueId: string; reference: string; category: string; reservationNumber: string;
    propertyName: string; quotes: string[]; dashboardOrigin?: string };
  nextAttemptAt: string; firstAttemptAt: string | null; lease?: string;
};

function parseEnvelope(body: string): Envelope {
  const e = JSON.parse(body) as Envelope;
  const p = e.retryPayload;
  if (e.kind !== "PIN_GO_EMAIL_DELIVERY" || e.type !== GUEST_INCIDENT_NOTICE || !p ||
      !p.issueId || !/^GI-[A-F0-9]{12}$/.test(p.reference) || !Array.isArray(p.quotes) ||
      p.quotes.length < 1 || p.quotes.length > 4 || p.quotes.some(q => typeof q !== "string" || q.length > 500) ||
      !Number.isFinite(Date.parse(e.nextAttemptAt)) ||
      (e.firstAttemptAt !== null && !Number.isFinite(Date.parse(e.firstAttemptAt)))) {
    throw new Error("PIN_AI_INCIDENT_NOTICE_INVALID");
  }
  return e;
}

// Processes one persisted notice. No provider call occurs until the CAS lease succeeds.
export async function deliverGuestIncidentNotice(input: {
  prisma: PrismaClient; message: MessageLog; env: IncidentEnvironment; now?: Date;
  send?: (mail: GuestIncidentEmail) => Promise<string>;
}) {
  const { prisma, message: m, env } = input;
  const now = input.now ?? new Date();
  if (env.PIN_AI_INCIDENT_NOTIFICATIONS_ENABLED !== "true" || !guestIncidentEnabled(m.reservationId ?? "", env)) return "DISABLED";
  const expected = { id: m.id, body: m.body, status: m.status, retryCount: m.retryCount,
    providerDeliveryStatus: m.providerDeliveryStatus, providerMessageId: m.providerMessageId };
  const terminal = async (reason: string, issueId?: string) => {
    const result = await prisma.messageLog.updateMany({ where: expected, data: { status: "FAILED_FINAL", error: reason } });
    if (result.count && issueId) await prisma.operationalIssue.updateMany({ where: {
      id: issueId, organizationId: m.organizationId, propertyId: m.propertyId, reservationId: m.reservationId,
      engine: "PIN_AI_GUEST_INCIDENT", workflowState: { not: "RESOLVED" },
    }, data: { recommendedAction: "Host notification needs attention. Review the guest incident directly in Dashboard. / El aviso requiere atención; revise el incidente en Dashboard." } });
    return "ATTENTION_REQUIRED";
  };
  let envelope: Envelope;
  try { envelope = parseEnvelope(m.body); } catch { return terminal("NOTICE_PAYLOAD_INVALID"); }
  const payload = envelope.retryPayload;
  if (["FAILED", "BOUNCED", "SUPPRESSED", "COMPLAINED"].includes(m.providerDeliveryStatus ?? "")) {
    // Provider terminal delivery failure is not a transport timeout. Do not blindly resend to a bounced/suppressed address.
    return terminal("NOTICE_PROVIDER_DELIVERY_FAILED", payload.issueId);
  }
  if (m.status === "SENT" && m.providerDeliveryStatus !== "DELIVERED" && envelope.firstAttemptAt &&
      now.getTime() - Date.parse(envelope.firstAttemptAt) >= 60 * 60_000) {
    return terminal("NOTICE_DELIVERY_UNCONFIRMED", payload.issueId);
  }
  if (!["QUEUED", "FAILED", "SENDING"].includes(m.status ?? "")) return "UNCHANGED";
  if (Date.parse(envelope.nextAttemptAt) > now.getTime()) return "NOT_DUE";
  if (m.retryCount >= MAX_ATTEMPTS || (envelope.firstAttemptAt && now.getTime() - Date.parse(envelope.firstAttemptAt) >= REPLAY_WINDOW_MS)) {
    return terminal("NOTICE_RETRY_BUDGET_EXHAUSTED", payload.issueId);
  }
  const issue = await prisma.operationalIssue.findFirst({ where: {
    id: payload.issueId, organizationId: m.organizationId, propertyId: m.propertyId, reservationId: m.reservationId,
    engine: "PIN_AI_GUEST_INCIDENT", visibility: "HOST",
  } });
  const reservation = await prisma.reservation.findFirst({ where: {
    id: m.reservationId ?? "", propertyId: m.propertyId ?? "", status: "ACTIVE", checkOut: { gt: now },
    property: { organizationId: m.organizationId ?? "", status: "ACTIVE" },
  }, select: { id: true } });
  const admins = await prisma.dashboardUser.findMany({ where: {
    organizationId: m.organizationId ?? "", isActive: true, role: "ORG_ADMIN",
  }, select: { email: true } });
  if (!issue || issue.workflowState === "RESOLVED" || !reservation ||
      !admins.some(a => a.email.trim().toLowerCase() === m.to)) {
    return terminal("NOTICE_SCOPE_OR_RECIPIENT_NO_LONGER_ELIGIBLE", payload.issueId);
  }
  let dashboardUrl: string;
  try {
    const origin = new URL(payload.dashboardOrigin ?? "");
    if (origin.protocol !== "https:" || origin.username || origin.password) throw new Error();
    dashboardUrl = `${origin.origin}/properties/${encodeURIComponent(m.propertyId!)}/calendar`;
  } catch { return terminal("NOTICE_DASHBOARD_URL_INVALID", payload.issueId); }
  const claimed = JSON.stringify({ ...envelope, firstAttemptAt: envelope.firstAttemptAt ?? now.toISOString(),
    nextAttemptAt: new Date(now.getTime() + LEASE_MS).toISOString(), lease: `${m.id}:${m.retryCount + 1}:${now.toISOString()}` });
  const claim = await prisma.messageLog.updateMany({ where: expected,
    data: { body: claimed, status: "SENDING", retryCount: { increment: 1 } } });
  if (!claim.count) return "CLAIM_LOST";
  let providerMessageId: string;
  try {
    providerMessageId = await (input.send ?? sendGuestIncidentHostNotice)({ to: m.to, ...payload, dashboardUrl,
      idempotencyKey: `pin-ai-incident:${m.id}` });
    if (!providerMessageId) throw new Error("NOTICE_ACK_MISSING");
  } catch (error) {
    const status = Number((error as { statusCode?: number })?.statusCode);
    const final = m.retryCount + 1 >= MAX_ATTEMPTS || (status >= 400 && status < 500 && status !== 429 && status !== 408);
    const nextBody = JSON.stringify({ ...JSON.parse(claimed), nextAttemptAt: new Date(now.getTime() +
      [60_000, 300_000, 900_000, 900_000][Math.min(m.retryCount, 3)]!).toISOString() });
    await prisma.messageLog.updateMany({ where: { id: m.id, body: claimed, status: "SENDING" },
      data: { body: nextBody, status: final ? "FAILED_FINAL" : "FAILED", error: final ? "NOTICE_SEND_FAILED_FINAL" : "NOTICE_SEND_RETRY_PENDING" } });
    if (final) await prisma.operationalIssue.updateMany({ where: { id: issue.id, workflowState: { not: "RESOLVED" } },
      data: { recommendedAction: "Host notification failed; review the guest incident in Dashboard. / Falló el aviso; revise el incidente en Dashboard." } });
    return final ? "ATTENTION_REQUIRED" : "RETRY_PENDING";
  }
  // If this write fails, leave SENDING. Recovery replays the SAME provider key, never creates a new notice.
  await prisma.messageLog.updateMany({ where: { id: m.id, body: claimed, status: "SENDING" },
    data: { status: "SENT", providerMessageId, error: null } });
  return "ACCEPTED";
}

let cursor: string | undefined;
export async function processGuestIncidentNotices(prisma: PrismaClient, env: IncidentEnvironment = process.env) {
  const parsed = parsePinAIActionCanaryReservationIds(env.PIN_AI_INCIDENT_CANARY_RESERVATION_IDS);
  if (env.PIN_AI_INCIDENT_ENABLED !== "true" || env.PIN_AI_INCIDENT_NOTIFICATIONS_ENABLED !== "true" || !parsed.valid || !parsed.ids.size) return;
  const rows = await prisma.messageLog.findMany({ where: {
    communicationType: GUEST_INCIDENT_NOTICE, provider: "resend", channel: "email",
    reservationId: { in: [...parsed.ids] },
    OR: [{ status: { in: ["QUEUED", "FAILED", "SENDING"] } }, { status: "SENT",
      OR: [{ providerDeliveryStatus: null }, { providerDeliveryStatus: { not: "DELIVERED" } }] }],
    ...(cursor ? { id: { gt: cursor } } : {}),
  }, orderBy: { id: "asc" }, take: 20 });
  cursor = rows.length === 20 ? rows[rows.length - 1]!.id : undefined;
  for (const message of rows) {
    try { await deliverGuestIncidentNotice({ prisma, message, env }); }
    catch { console.error("[PIN_AI_INCIDENT_NOTICE] persistence failed; durable notice retained", { messageId: message.id }); }
  }
}
