import type { Prisma, PrismaClient, MessageLog } from "@prisma/client";
import { validId } from "../../channex-messaging/host-inbox.js";
import { autoConfig } from "../../channex-messaging/pin-ai-auto.policy.js";
import { guestIncidentRecipientWhere } from "../guest/guest-incident-recipient-policy.js";
import { fail, openHostContent, type HostEnvironment } from "./host-incident-policy.js";
import type { buildHostInboxRuntime } from "../../channex-messaging/host-inbox.runtime.js";

export const HOST_CHANNEL_UPDATE = "PIN_AI_HOST_INCIDENT_CHANNEL_UPDATE";
export const channelUpdateId = (eventId: string) => `host-incident-channel:${eventId}`;
type Destination = { issueId: string; eventId: string; threadId: string; bookingId: string };

export function incidentChannelDestination(issue: { id: string; metadata: Prisma.JsonValue | null }, reservation: { externalProvider: string | null; externalId: string | null }) {
  const metadata = issue.metadata as Record<string, unknown> | null;
  if (metadata?.channelSource !== "CHANNEX") return null;
  const threadId = metadata.channelThreadId, bookingId = metadata.channelBookingId;
  if (typeof threadId !== "string" || typeof bookingId !== "string" || !validId(threadId) || !validId(bookingId) ||
      reservation.externalProvider !== "CHANNEX" || reservation.externalId !== bookingId) return fail(409, "INCIDENT_CHANNEL_NOT_LINKED");
  return { issueId: issue.id, threadId, bookingId };
}

// Created in the same transaction as the host-approved, encrypted PUBLISH event.
// Existing publications without an outbox are never replayed automatically.
export async function queueIncidentChannelUpdate(tx: Prisma.TransactionClient, input: {
  organizationId: string; propertyId: string; reservationId: string; eventId: string;
  destination: Omit<Destination, "eventId">;
}) {
  return tx.messageLog.create({ data: { id: channelUpdateId(input.eventId), channel: "ota", provider: "channex",
    to: input.destination.threadId, organizationId: input.organizationId, propertyId: input.propertyId,
    reservationId: input.reservationId, communicationType: HOST_CHANNEL_UPDATE, status: "QUEUED",
    body: JSON.stringify({ ...input.destination, eventId: input.eventId }) } });
}

export async function deliverIncidentChannelUpdate(input: {
  prisma: PrismaClient; env: HostEnvironment; message: MessageLog;
  runtime: NonNullable<ReturnType<typeof buildHostInboxRuntime>>;
}) {
  const { prisma, env, message: m, runtime } = input;
  if (!m.organizationId || !m.propertyId || !m.reservationId || !autoConfig(env).allows({ organizationId: m.organizationId, propertyId: m.propertyId })) return "DISABLED";
  const scope = { organizationId: m.organizationId, propertyId: m.propertyId };
  let claimedSend = false;
  const finish = async (status: string, error: string | null, providerMessageId?: string) => {
    await prisma.messageLog.updateMany({ where: { id: m.id, status: claimedSend ? "SENDING" : m.status },
      data: { status, error, ...(providerMessageId ? { providerMessageId } : {}) } });
    return status;
  };
  let payload: Destination;
  try {
    payload = JSON.parse(m.body);
    if (m.communicationType !== HOST_CHANNEL_UPDATE || m.channel !== "ota" || m.provider !== "channex" ||
        !payload.eventId || !payload.issueId || !validId(payload.threadId) || !validId(payload.bookingId) ||
        m.id !== channelUpdateId(payload.eventId) || m.to !== payload.threadId) throw new Error();
  } catch { return finish("BLOCKED", "INCIDENT_CHANNEL_PAYLOAD_INVALID"); }
  const requestKey = `incident-host-${payload.eventId}`;
  const receipt = await prisma.channexHostMessageSend.findUnique({ where: { organizationId_requestKey: { organizationId: scope.organizationId, requestKey } } });
  if (receipt) {
    if (receipt.propertyId !== scope.propertyId || receipt.threadId !== payload.threadId) return finish("BLOCKED", "INCIDENT_CHANNEL_RECEIPT_INVALID");
    const response = receipt.response as Record<string, unknown> | null;
    return receipt.status === "SENT" && typeof response?.id === "string" ? finish("SENT", null, response.id) : finish("UNKNOWN", "INCIDENT_CHANNEL_SEND_UNCONFIRMED");
  }
  // Once a send starts, transport uncertainty is never automatically replayed.
  if (m.status === "SENDING") return finish("UNKNOWN", "INCIDENT_CHANNEL_SEND_UNCONFIRMED");
  if (m.status !== "QUEUED") return m.status;
  const event = await prisma.pinAIHostIncidentMessage.findFirst({ where: { id: payload.eventId, kind: "PUBLISH", audience: "GUEST",
    thread: { issueId: payload.issueId, organizationId: scope.organizationId, propertyId: scope.propertyId, reservationId: m.reservationId } },
    include: { thread: { include: { issue: true } } } });
  const reservation = await prisma.reservation.findFirst({ where: { id: m.reservationId, propertyId: scope.propertyId,
    property: { organizationId: scope.organizationId, status: "ACTIVE" } }, select: { externalId: true, externalProvider: true } });
  const actor = event ? await prisma.dashboardUser.findFirst({ where: { id: event.actorId, ...guestIncidentRecipientWhere(scope.organizationId) }, select: { id: true } }) : null;
  if (!event || !reservation || !actor) return finish("BLOCKED", "INCIDENT_CHANNEL_SCOPE_REVOKED");
  try {
    const destination = incidentChannelDestination(event.thread.issue, reservation);
    if (!destination || destination.threadId !== payload.threadId || destination.bookingId !== payload.bookingId) return finish("BLOCKED", "INCIDENT_CHANNEL_DESTINATION_CHANGED");
    const history = await runtime.messages(scope, payload.threadId, { page: 1, limit: 1 });
    if (history.thread.bookingId !== payload.bookingId || history.thread.isClosed || !["airbnb", "bookingcom", "expedia"].includes(history.thread.provider.toLowerCase())) return finish("BLOCKED", "INCIDENT_CHANNEL_THREAD_CHANGED");
    // Same host takeover/concurrency fence as Dashboard Messages. A busy AI
    // send postpones this queued host publication instead of issuing two sends.
    await runtime.automation.beforeHostReply({ ...scope, threadId: payload.threadId });
    const text = openHostContent(env, `${scope.organizationId}:${event.threadId}:${event.sequence}:GUEST`, event.contentCiphertext);
    const claimed = await prisma.messageLog.updateMany({ where: { id: m.id, status: "QUEUED" }, data: { status: "SENDING", providerStatusUpdatedAt: new Date(), retryCount: { increment: 1 } } });
    if (!claimed.count) return "UNCHANGED";
    claimedSend = true;
    try {
      const result = await runtime.reply({ ...scope, threadId: payload.threadId, text, requestedBy: event.actorId, requestKey });
      return finish("SENT", null, result.message.id);
    } catch { return finish("UNKNOWN", "INCIDENT_CHANNEL_SEND_UNCONFIRMED"); }
  } catch { return "QUEUED"; }
}

export async function processIncidentChannelUpdates(prisma: PrismaClient, env: HostEnvironment, runtime: NonNullable<ReturnType<typeof buildHostInboxRuntime>>) {
  const cutoff = new Date(Date.now() - 120_000);
  const rows = await prisma.messageLog.findMany({ where: { communicationType: HOST_CHANNEL_UPDATE, provider: "channex", channel: "ota",
    OR: [{ status: "QUEUED" }, { status: "SENDING", providerStatusUpdatedAt: { lt: cutoff } },
      { status: "UNKNOWN", createdAt: { gt: new Date(Date.now() - 86400000) } }] }, orderBy: [{ status: "asc" }, { createdAt: "asc" }, { id: "asc" }], take: 10 });
  for (const message of rows) await deliverIncidentChannelUpdate({ prisma, env, message, runtime });
}
