import { Prisma, type PrismaClient } from "@prisma/client";
import { resolveOtaConnectionCenterConfig } from "../distribution/ota-connection-center.config.js";
import { decryptAccessCode } from "../services/access-code-crypto.service.js";
import { createHostInbox, createInboxHttpRequest, validId, type InboxRequest, type Thread } from "./host-inbox.js";
import { airbnbDeliveryId, buildAirbnbAccessText, ownsAirbnbCommunication, type AirbnbCommunicationType } from "./airbnb-access.policy.js";

export type AirbnbDeliveryResult = { ok: boolean; status: "SENT" | "FAILED"; error?: string; replayed?: boolean; skipped?: boolean };
const reservationInclude = { property: true, accessGrants: { include: { secureAccessCode: true } } } as const;

export async function airbnbOwnsReservation(prisma: PrismaClient, reservationId: string, env = process.env) {
  if (env.CHANNEX_AIRBNB_ACCESS_ENABLED !== "true") return false;
  const r = await prisma.reservation.findUnique({ where: { id: reservationId }, include: { property: true } });
  return Boolean(r && ownsAirbnbCommunication({ ...r, organizationId: r.property.organizationId }, env));
}

/** null means the existing channel still owns this reservation. Failure NEVER means fallback. */
export async function deliverAirbnbCommunication(
  prisma: PrismaClient, reservationId: string, type: AirbnbCommunicationType,
  options: { env?: NodeJS.ProcessEnv; now?: Date; request?: InboxRequest; decrypt?: typeof decryptAccessCode } = {},
): Promise<AirbnbDeliveryResult | null> {
  const env = options.env ?? process.env;
  if (env.CHANNEX_AIRBNB_ACCESS_ENABLED !== "true") return null;
  const r = await prisma.reservation.findUnique({ where: { id: reservationId }, include: reservationInclude });
  if (!r || !ownsAirbnbCommunication({ ...r, organizationId: r.property.organizationId }, env)) return null;
  const fail = (error: string): AirbnbDeliveryResult => ({ ok: false, status: "FAILED", error });
  const now = options.now ?? new Date();
  if (r.status !== "ACTIVE" || r.cancelledAt) return fail("AIRBNB_RESERVATION_INACTIVE");
  if (r.paymentState !== "PAID") return fail("AIRBNB_RESERVATION_NOT_PAID");
  if (!r.externalId || !validId(r.externalId)) return fail("AIRBNB_BOOKING_MAPPING_MISSING");
  if (!r.property.timezone) return fail("AIRBNB_PROPERTY_TIMEZONE_MISSING");
  if (type === "PRECHECKIN" && (now >= r.checkIn || r.checkIn.getTime() - now.getTime() > 4 * 3600000)) return fail("AIRBNB_PRECHECKIN_NOT_DUE");
  if (type === "GUEST_ACCESS_PASSCODE" && now >= r.checkOut) return fail("AIRBNB_ACCESS_EXPIRED");
  if (type === "CHECKOUT" && (now < r.checkOut || now.getTime() - r.checkOut.getTime() > 3600000)) return fail("AIRBNB_CHECKOUT_NOT_DUE");
  const grants = r.accessGrants.filter(g => g.type === "GUEST" && g.method === "PASSCODE_TIMEBOUND" &&
    g.status === "ACTIVE" && g.lastAppliedAt && g.startsAt.getTime() === r.checkIn.getTime() &&
    g.endsAt.getTime() === r.checkOut.getTime() && g.secureAccessCode?.accessCodeHash && g.secureAccessCode.accessCodeEnc);
  const grant = type === "GUEST_ACCESS_PASSCODE" && grants.length === 1 ? grants[0] : undefined;
  if (type === "GUEST_ACCESS_PASSCODE" && (!grant || r.guestAccessReleaseStatus !== "RELEASED" || !r.guestAccessReleasedAt)) return fail("AIRBNB_ACCESS_NOT_RELEASED");
  const scope = { ...r, organizationId: r.property.organizationId };
  const receiptId = airbnbDeliveryId({ ...scope, type, accessGrantId: grant?.id ?? null, accessCodeHash: grant?.secureAccessCode?.accessCodeHash ?? null });
  const prior = await prisma.messageLog.findUnique({ where: { id: receiptId } });
  if (prior) return prior.status === "SENT" ? { ok: true, status: "SENT", replayed: true } : fail("AIRBNB_SEND_OUTCOME_UNKNOWN");
  const config = resolveOtaConnectionCenterConfig(env);
  if (!config.enabled && !options.request) return fail("AIRBNB_TRANSPORT_DISABLED");
  const request = options.request ?? (config.enabled ? createInboxHttpRequest({ apiOrigin: config.provider.apiOrigin, apiKey: config.provider.apiKey }) : null);
  if (!request) return fail("AIRBNB_TRANSPORT_DISABLED");
  const mapping = await prisma.distributionProperty.findFirst({ where: {
    organizationId: scope.organizationId, propertyId: r.propertyId, platform: "CHANNEX", provisioningStatus: "READY",
    property: { organizationId: scope.organizationId, status: "ACTIVE" },
    group: { organizationId: scope.organizationId, provisioningStatus: "READY", externalGroupId: { not: null } },
  }, select: { externalPropertyId: true } });
  if (!mapping?.externalPropertyId || !validId(mapping.externalPropertyId)) return fail("AIRBNB_PROPERTY_MAPPING_MISSING");
  const remotePropertyId = mapping.externalPropertyId;
  const readonlyInbox = createHostInbox({ request, resolveProperty: async () => remotePropertyId,
    reserve: async () => { throw new Error("AIRBNB_HOST_SEND_FORBIDDEN"); },
    complete: async () => { throw new Error("AIRBNB_HOST_SEND_FORBIDDEN"); },
    unknown: async () => { throw new Error("AIRBNB_HOST_SEND_FORBIDDEN"); },
  });
  let matching: Thread[] = [];
  try {
    for (let page = 1; page <= 50; page++) {
      const result = await readonlyInbox.list(scope, { page, limit: 100 });
      matching.push(...result.items.filter(t => t.bookingId === r.externalId));
      if (page * 100 >= result.total) break;
      if (page === 50) return fail("AIRBNB_THREAD_SEARCH_LIMIT");
    }
    if (matching.length !== 1) return fail("AIRBNB_BOOKING_THREAD_MISSING_OR_AMBIGUOUS");
    const thread = matching[0]!;
    const detail = await readonlyInbox.messages(scope, thread.id, { page: 1, limit: 1 });
    if (detail.thread.bookingId !== r.externalId || detail.thread.provider.toLowerCase() !== "airbnb" || detail.thread.isClosed) return fail("AIRBNB_THREAD_NOT_ELIGIBLE");
    const current = await prisma.reservation.findUnique({ where: { id: reservationId }, include: reservationInclude });
    // Compare current scope and credential evidence immediately before the durable send fence.
    if (!current || JSON.stringify(current) !== JSON.stringify(r)) return fail("AIRBNB_RESERVATION_CHANGED");
    const code = grant?.secureAccessCode?.accessCodeEnc ? (options.decrypt ?? decryptAccessCode)(grant.secureAccessCode.accessCodeEnc) : undefined;
    const text = buildAirbnbAccessText({ type, propertyName: r.property.name, language: r.preferredLanguage,
      timezone: r.property.timezone, checkIn: r.checkIn, checkOut: r.checkOut, address: r.property.address1,
      ...(code ? { code, unlockKey: grant?.unlockKey ?? "#" } : {}),
    });
    if (text.length > 5000) return fail("AIRBNB_MESSAGE_TOO_LONG");
    try {
      await prisma.messageLog.create({ data: {
        id: receiptId, channel: "channex", provider: "channex", to: thread.id, status: "AIRBNB_SENDING",
        organizationId: scope.organizationId, propertyId: r.propertyId, reservationId: r.id,
        communicationType: type, accessGrantId: grant?.id ?? null,
        // No plaintext code, bearer link, guest content or provider response is persisted.
        body: JSON.stringify({ kind: "PIN_GO_AIRBNB_DELIVERY", type, bookingId: r.externalId }),
      } });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
      const existing = await prisma.messageLog.findUnique({ where: { id: receiptId } });
      return existing?.status === "SENT" ? { ok: true, status: "SENT", replayed: true } : fail("AIRBNB_SEND_OUTCOME_UNKNOWN");
    }
    try {
      const response = await request({ method: "POST", path: `/api/v1/message_threads/${thread.id}/messages`, body: { message: { message: text } } }) as any;
      const data = response?.data;
      if (data?.type !== "message" || !validId(String(data.id)) || data.attributes?.sender !== "property" ||
        data.relationships?.message_thread?.data?.id !== thread.id || data.attributes?.message !== text) throw new Error("AIRBNB_RESPONSE_INVALID");
      const saved = await prisma.messageLog.updateMany({ where: { id: receiptId, status: "AIRBNB_SENDING" }, data: { status: "SENT", providerMessageId: data.id, error: null } });
      if (saved.count !== 1) throw new Error("AIRBNB_RECEIPT_NOT_SAVED");
      return { ok: true, status: "SENT" };
    } catch {
      await prisma.messageLog.updateMany({ where: { id: receiptId, status: "AIRBNB_SENDING" }, data: { status: "AIRBNB_UNKNOWN", error: "AIRBNB_SEND_OUTCOME_UNKNOWN" } }).catch(() => {});
      return fail("AIRBNB_SEND_OUTCOME_UNKNOWN");
    }
  } catch {
    return fail("AIRBNB_PREFLIGHT_FAILED");
  }
}

/** Scan the explicit canary independently of email/phone availability and legacy access workers. */
export async function processAirbnbCommunications(prisma: PrismaClient, env = process.env, now = new Date()) {
  if (env.CHANNEX_AIRBNB_ACCESS_ENABLED !== "true") return;
  const ids = [...new Set((env.CHANNEX_AIRBNB_ACCESS_RESERVATION_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean))];
  if (ids.length > 50) throw new Error("AIRBNB_CANARY_SCOPE_TOO_LARGE");
  for (const id of ids) {
    for (const type of ["PRECHECKIN", "GUEST_ACCESS_PASSCODE", "CHECKOUT"] as const) {
      try {
        const result = await deliverAirbnbCommunication(prisma, id, type, { env, now });
        if (result && !result.ok && !["AIRBNB_PRECHECKIN_NOT_DUE", "AIRBNB_CHECKOUT_NOT_DUE", "AIRBNB_ACCESS_EXPIRED", "AIRBNB_ACCESS_NOT_RELEASED"].includes(result.error ?? "")) {
          console.error("[AIRBNB_COMMUNICATION_BLOCKED]", { reservationId: id, type, error: result.error });
        }
      } catch {
        console.error("[AIRBNB_COMMUNICATION_BLOCKED]", { reservationId: id, type, error: "AIRBNB_INTERNAL_ERROR" });
      }
    }
  }
}

/** Retire the former route, never replay its body or change staff/host messages. */
export async function retireAirbnbLegacyRetry(prisma: PrismaClient, message: {
  id: string; reservationId: string | null; communicationType: string | null; status: string | null; body?: string;
}) {
  let type = message.communicationType;
  if (!type && message.body) {
    try {
      const envelope = JSON.parse(message.body);
      if (envelope?.kind === "PIN_GO_EMAIL_DELIVERY") type = envelope.type;
    } catch { /* Ordinary SMS bodies are not envelopes. */ }
  }
  if (!message.reservationId || !["APMS_PENDING", "FAILED", "FAILED_FINAL"].includes(message.status ?? "") ||
    !["PRECHECKIN", "GUEST_ACCESS_PASSCODE", "CHECKOUT"].includes(type ?? "")) return false;
  if (!await airbnbOwnsReservation(prisma, message.reservationId)) return false;
  await prisma.messageLog.updateMany({ where: { id: message.id, status: message.status },
    data: { status: "OBSOLETE", error: "AIRBNB_CHANNEL_OWNS_DELIVERY" } });
  // The independent scan uses current dates and encrypted credential evidence.
  return true;
}
