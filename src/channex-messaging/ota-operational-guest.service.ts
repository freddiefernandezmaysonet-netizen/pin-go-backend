import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { resolveOtaConnectionCenterConfig } from "../distribution/ota-connection-center.config.js";
import { decryptAccessCode } from "../services/access-code-crypto.service.js";
import { formatPropertyArrivalLocation } from "../services/property-arrival-location.js";
import {
  isOtaGuestExternalDeliveryBlocked,
  resolveChannexOperationalProvider,
} from "../services/ota-guest-external-messaging.policy.js";
import {
  createHostInbox, createInboxHttpRequest, validId,
  type InboxRequest, type Thread,
} from "./host-inbox.js";
import {
  buildAirbnbAccessText, type AirbnbCommunicationType,
} from "./airbnb-access.policy.js";
import {
  deliverAirbnbCommunication, type AirbnbDeliveryResult,
} from "./airbnb-access.service.js";

const reservationInclude = {
  property: true,
  accessGrants: { include: { secureAccessCode: true } },
} as const;

const failure = (code: string): AirbnbDeliveryResult => ({
  ok: false, status: "FAILED", error: code,
});

/**
 * Pilot-compatible operational delivery.
 * - No configuration => existing Airbnb pilot behavior is unchanged.
 * - A blocked Airbnb/Booking.com OTA owns its Channex delivery, even when
 *   the thread is absent: NEVER fall back to Twilio/Resend.
 * - Provider acceptance is not recipient delivery confirmation.
 */
export async function deliverOtaOperationalCommunication(
  prisma: PrismaClient,
  reservationId: string,
  type: AirbnbCommunicationType,
  options: {
    env?: NodeJS.ProcessEnv;
    now?: Date;
    request?: InboxRequest;
    decrypt?: typeof decryptAccessCode;
  } = {},
): Promise<AirbnbDeliveryResult | null> {
  const env = options.env ?? process.env;
  const pilot = await deliverAirbnbCommunication(prisma, reservationId, type, options);
  if (pilot) return pilot;
  if (!String(env.OTA_GUEST_EXTERNAL_MESSAGING_BLOCKED_PROVIDERS ?? "").trim()) return null;

  const r = await prisma.reservation.findUnique({
    where: { id: reservationId }, include: reservationInclude,
  });
  if (!r || !isOtaGuestExternalDeliveryBlocked(r, "sms", env)) return null;
  const provider = resolveChannexOperationalProvider(r);
  if (!provider) return failure("OTA_OPERATIONAL_PROVIDER_INVALID");

  const now = options.now ?? new Date();
  if (r.status !== "ACTIVE" || r.cancelledAt) return failure("OTA_OPERATIONAL_RESERVATION_INACTIVE");
  if (r.paymentState !== "PAID") return failure("OTA_OPERATIONAL_RESERVATION_NOT_PAID");
  if (!validId(r.externalId ?? "")) return failure("OTA_OPERATIONAL_BOOKING_ID_INVALID");
  if (!r.property.timezone) return failure("OTA_OPERATIONAL_TIMEZONE_MISSING");
  if (type === "PRECHECKIN" &&
    (now >= r.checkIn || r.checkIn.getTime() - now.getTime() > 4 * 3600000))
    return failure("OTA_OPERATIONAL_PRECHECKIN_NOT_DUE");
  if (type === "CHECKOUT" &&
    (now < r.checkOut || now.getTime() - r.checkOut.getTime() > 3600000))
    return failure("OTA_OPERATIONAL_CHECKOUT_NOT_DUE");
  if (type === "GUEST_ACCESS_PASSCODE" && now >= r.checkOut)
    return failure("OTA_OPERATIONAL_ACCESS_EXPIRED");

  const grants = r.accessGrants.filter(g =>
    g.type === "GUEST" && g.method === "PASSCODE_TIMEBOUND" &&
    g.status === "ACTIVE" && g.lastAppliedAt &&
    g.startsAt.getTime() === r.checkIn.getTime() &&
    g.endsAt.getTime() === r.checkOut.getTime() &&
    g.secureAccessCode?.accessCodeHash && g.secureAccessCode.accessCodeEnc,
  );
  const grant = type === "GUEST_ACCESS_PASSCODE" && grants.length === 1
    ? grants[0] : undefined;
  if (type === "GUEST_ACCESS_PASSCODE" &&
      (!grant || r.guestAccessReleaseStatus !== "RELEASED" || !r.guestAccessReleasedAt))
    return failure("OTA_OPERATIONAL_ACCESS_NOT_RELEASED");

  const scope = { organizationId: r.property.organizationId, propertyId: r.propertyId };
  const receiptId = "otacomm_" + createHash("sha256").update(JSON.stringify([
    scope.organizationId, scope.propertyId, r.id, r.externalId,
    provider, type, r.checkIn.toISOString(), r.checkOut.toISOString(),
    type === "GUEST_ACCESS_PASSCODE" ? grant?.id : null,
    type === "GUEST_ACCESS_PASSCODE" ? grant?.secureAccessCode?.accessCodeHash : null,
  ])).digest("hex");
  const prior = await prisma.messageLog.findUnique({ where: { id: receiptId } });
  if (prior) return prior.status === "SENT"
    ? { ok: true, status: "SENT", replayed: true }
    : failure("OTA_OPERATIONAL_SEND_OUTCOME_UNKNOWN");

  const config = resolveOtaConnectionCenterConfig(env);
  if (!config.enabled && !options.request) return failure("OTA_OPERATIONAL_TRANSPORT_DISABLED");
  const request = options.request ?? (config.enabled
    ? createInboxHttpRequest({
        apiOrigin: config.provider.apiOrigin, apiKey: config.provider.apiKey,
      }) : null);
  if (!request) return failure("OTA_OPERATIONAL_TRANSPORT_DISABLED");

  const mapping = await prisma.distributionProperty.findFirst({
    where: {
      organizationId: scope.organizationId, propertyId: scope.propertyId,
      platform: "CHANNEX", provisioningStatus: "READY",
      property: { organizationId: scope.organizationId, status: "ACTIVE" },
      group: {
        organizationId: scope.organizationId, provisioningStatus: "READY",
        externalGroupId: { not: null },
      },
    },
    select: { externalPropertyId: true },
  });
  if (!mapping?.externalPropertyId || !validId(mapping.externalPropertyId))
    return failure("OTA_OPERATIONAL_MAPPING_MISSING");

  const inbox = createHostInbox({
    request,
    resolveProperty: async () => mapping.externalPropertyId!,
    reserve: async () => { throw Error("OTA_OPERATIONAL_HOST_SEND_FORBIDDEN"); },
    complete: async () => { throw Error("OTA_OPERATIONAL_HOST_SEND_FORBIDDEN"); },
    unknown: async () => { throw Error("OTA_OPERATIONAL_HOST_SEND_FORBIDDEN"); },
  });

  try {
    const matching: Thread[] = [];
    for (let page = 1; page <= 50; page++) {
      const response = await inbox.list(scope, { page, limit: 100 });
      matching.push(...response.items.filter(t => t.bookingId === r.externalId));
      if (page * 100 >= response.total) break;
      if (page === 50) return failure("OTA_OPERATIONAL_THREAD_SEARCH_LIMIT");
    }
    if (matching.length !== 1)
      return failure("OTA_OPERATIONAL_THREAD_MISSING_OR_AMBIGUOUS");
    const thread = matching[0]!;
    const detail = await inbox.messages(scope, thread.id, { page: 1, limit: 1 });
    const expected = provider === "AIRBNB" ? "airbnb" : "bookingcom";
    if (detail.thread.bookingId !== r.externalId ||
        detail.thread.provider.toLowerCase() !== expected ||
        detail.thread.isClosed)
      return failure("OTA_OPERATIONAL_THREAD_NOT_ELIGIBLE");

    const current = await prisma.reservation.findUnique({
      where: { id: reservationId }, include: reservationInclude,
    });
    if (!current || JSON.stringify(current) !== JSON.stringify(r))
      return failure("OTA_OPERATIONAL_RESERVATION_CHANGED");

    const code = grant?.secureAccessCode?.accessCodeEnc
      ? (options.decrypt ?? decryptAccessCode)(grant.secureAccessCode.accessCodeEnc)
      : undefined;
    // Existing OTA-neutral Pin&Go text builder, retained for Airbnb parity.
    const text = buildAirbnbAccessText({
      type, propertyName: r.property.name, language: r.preferredLanguage,
      arrivalLocation: formatPropertyArrivalLocation(r.property, r.preferredLanguage),
      timezone: r.property.timezone, checkIn: r.checkIn, checkOut: r.checkOut,
      address: r.property.address1,
      ...(code ? { code, unlockKey: grant?.unlockKey ?? "#" } : {}),
    });
    if (!text.trim() || text.length > 5000)
      return failure("OTA_OPERATIONAL_MESSAGE_INVALID");

    try {
      await prisma.messageLog.create({
        data: {
          id: receiptId, channel: "channex", provider: "channex",
          to: thread.id, status: "CHANNEX_SENDING",
          organizationId: scope.organizationId, propertyId: scope.propertyId,
          reservationId: r.id, communicationType: type,
          accessGrantId: grant?.id ?? null,
          // Keep access credentials, guest data, and provider payload out of logs.
          body: JSON.stringify({
            kind: "PIN_GO_OTA_OPERATIONAL_DELIVERY",
            provider, type, bookingId: r.externalId,
          }),
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== "P2002") throw error;
      const existing = await prisma.messageLog.findUnique({ where: { id: receiptId } });
      return existing?.status === "SENT"
        ? { ok: true, status: "SENT", replayed: true }
        : failure("OTA_OPERATIONAL_SEND_OUTCOME_UNKNOWN");
    }

    try {
      const response = await request({
        method: "POST", path: "/api/v1/message_threads/" + thread.id + "/messages",
        body: { message: { message: text } },
      }) as any;
      const data = response?.data;
      if (data?.type !== "message" || !validId(String(data.id)) ||
          data.attributes?.sender !== "property" ||
          data.relationships?.message_thread?.data?.id !== thread.id ||
          data.attributes?.message !== text)
        throw Error("OTA_OPERATIONAL_PROVIDER_RESPONSE_INVALID");
      const saved = await prisma.messageLog.updateMany({
        where: { id: receiptId, status: "CHANNEX_SENDING" },
        data: { status: "SENT", providerMessageId: data.id, error: null },
      });
      if (saved.count !== 1) throw Error("OTA_OPERATIONAL_RECEIPT_NOT_SAVED");
      return { ok: true, status: "SENT" };
    } catch {
      await prisma.messageLog.updateMany({
        where: { id: receiptId, status: "CHANNEX_SENDING" },
        data: { status: "CHANNEX_UNKNOWN", error: "OTA_OPERATIONAL_SEND_OUTCOME_UNKNOWN" },
      }).catch(() => {});
      return failure("OTA_OPERATIONAL_SEND_OUTCOME_UNKNOWN");
    }
  } catch {
    return failure("OTA_OPERATIONAL_PREFLIGHT_FAILED");
  }
}
