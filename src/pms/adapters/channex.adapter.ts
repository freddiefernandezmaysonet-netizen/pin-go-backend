import crypto from "crypto";
import axios from "axios";
import type {
  CanonicalReservation,
  ChannexBookingRevision,
  ChannexBookingWebhookEventType,
  PmsAdapter,
  PmsAdapterConnection,
} from "./types";

const CHANNEX_API_BASE_URL =
  process.env.CHANNEX_API_BASE_URL ?? "https://staging.channex.io";
const CHANNEX_REQUEST_TIMEOUT_MS = 15_000;

const CHANNEX_BOOKING_EVENTS = new Set<ChannexBookingWebhookEventType>([
  "booking",
  "booking_new",
  "booking_modification",
  "booking_cancellation",
  "non_acked_booking",
]);

function asString(value: unknown): string | null {
  if (value == null) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const str = asString(value);
    if (str) return str;
  }
  return null;
}

function getEncryptionKey() {
  const secret = process.env.PMS_CREDENTIALS_SECRET ?? "";
  if (!secret) throw new Error("PMS_CREDENTIALS_SECRET not configured");
  return crypto.createHash("sha256").update(secret).digest();
}

function decryptJson(encryptedValue: string): any {
  const raw = Buffer.from(encryptedValue, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);

  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString("utf8"));
}

function getChannexApiKey(connection: PmsAdapterConnection) {
  if (connection.credentialsEncrypted) {
    const creds = decryptJson(connection.credentialsEncrypted);
    const apiKey = asString(creds?.apiKey);
    if (apiKey) return apiKey;
  }

  const envApiKey = asString(process.env.CHANNEX_API_KEY);
  if (envApiKey) return envApiKey;

  throw new Error("CHANNEX_NO_API_KEY");
}

function getChannexBaseUrl() {
  return CHANNEX_API_BASE_URL.replace(/\/+$/, "");
}

function getChannexHeaders(connection: PmsAdapterConnection) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "user-api-key": getChannexApiKey(connection),
  };
}

function payloadRoot(body: any) {
  return body?.payload ?? body?.data ?? body;
}

function normalizeWebhookEventType(value: unknown) {
  return String(value ?? "booking").trim().toLowerCase();
}

function normalizeStatus(value: unknown): CanonicalReservation["status"] {
  const status = String(value ?? "").trim().toUpperCase();

  if (["CANCELLED", "CANCELED"].includes(status)) return "CANCELLED";
  if (status === "INQUIRY") return "INQUIRY";
  if (["HOLD", "HELD"].includes(status)) return "HOLD";

  return "CONFIRMED";
}

function extractResource(raw: any) {
  const data = raw?.data ?? raw;
  const attributes = data?.attributes ?? data;

  return {
    resourceId: firstString(data?.id, attributes?.booking_revision_id),
    attributes:
      attributes?.booking_revision ??
      attributes?.revision ??
      attributes?.booking ??
      attributes,
  };
}

function extractBooking(raw: any) {
  return extractResource(raw).attributes;
}

function getPrimaryRoom(raw: any, booking: any) {
  if (Array.isArray(booking?.rooms) && booking.rooms.length > 0) {
    return booking.rooms[0];
  }

  if (Array.isArray(raw?.rooms) && raw.rooms.length > 0) {
    return raw.rooms[0];
  }

  if (
    Array.isArray(raw?.data?.attributes?.rooms) &&
    raw.data.attributes.rooms.length > 0
  ) {
    return raw.data.attributes.rooms[0];
  }

  return null;
}

function toCanonicalReservation(
  raw: any,
  fallbackBookingId: string
): CanonicalReservation {
  const booking = extractBooking(raw);
  const primaryRoom = getPrimaryRoom(raw, booking);
  const externalReservationId =
    firstString(booking?.booking_id, booking?.bookingId, fallbackBookingId) ??
    fallbackBookingId;
  const externalListingId = firstString(
    primaryRoom?.room_type_id,
    primaryRoom?.roomTypeId,
    booking?.room_type_id,
    booking?.roomTypeId
  );

  if (!externalListingId) {
    throw new Error("CHANNEX_MISSING_ROOM_TYPE_ID");
  }

  const checkIn = firstString(
    booking?.arrival_date,
    booking?.arrivalDate,
    primaryRoom?.checkin_date,
    primaryRoom?.checkInDate,
    booking?.check_in,
    booking?.checkIn
  );
  let checkOut = firstString(
    booking?.departure_date,
    booking?.departureDate,
    primaryRoom?.checkout_date,
    primaryRoom?.checkOutDate,
    booking?.check_out,
    booking?.checkOut
  );

  if (!checkOut) {
    const nights = Number(
      booking?.count_of_nights ??
        booking?.nights ??
        booking?.number_of_nights ??
        0
    );

    if (checkIn && Number.isFinite(nights) && nights > 0) {
      const checkoutDate = new Date(`${checkIn}T00:00:00.000Z`);
      checkoutDate.setUTCDate(checkoutDate.getUTCDate() + nights);
      checkOut = checkoutDate.toISOString().slice(0, 10);
    }
  }

  if (!checkIn || !checkOut) {
    throw new Error("CHANNEX_MISSING_DATES");
  }

  const timezone = firstString(booking?.timezone, booking?.time_zone);
  const guestName = firstString(
    booking?.guest_name,
    booking?.guestName,
    booking?.customer?.name,
    booking?.guest?.name
  );
  const guestEmail = firstString(
    booking?.guest_email,
    booking?.guestEmail,
    booking?.customer?.email,
    booking?.guest?.email
  );
  const guestPhone = firstString(
    booking?.guest_phone,
    booking?.guestPhone,
    booking?.customer?.phone,
    booking?.guest?.phone
  );
  const adults =
    Number(booking?.adults ?? booking?.occupancy?.adults ?? 0) || null;
  const children =
    Number(booking?.children ?? booking?.occupancy?.children ?? 0) || null;
  const notes = firstString(
    booking?.notes,
    booking?.remarks,
    booking?.special_request
  );

  return {
    provider: "CHANNEX",
    externalReservationId,
    externalListingId,
    listingName:
      firstString(
        primaryRoom?.room_type_name,
        primaryRoom?.roomTypeName,
        booking?.room_type_name,
        booking?.roomTypeName,
        booking?.property_name,
        booking?.propertyName
      ) ?? null,
    status: normalizeStatus(
      booking?.status ?? booking?.booking_status ?? booking?.state
    ),
    checkIn,
    checkOut,
    ...(timezone ? { timezone } : {}),
    guest: {
      ...(guestName ? { name: guestName } : {}),
      ...(guestEmail ? { email: guestEmail } : {}),
      ...(guestPhone ? { phone: guestPhone } : {}),
    },
    party: {
      ...(adults !== null ? { adults } : {}),
      ...(children !== null ? { children } : {}),
    },
    ...(notes ? { notes } : {}),
    raw: booking,
  };
}

function toChannexBookingRevision(raw: any): ChannexBookingRevision {
  const { resourceId, attributes } = extractResource(raw);
  const revisionId = firstString(
    resourceId,
    attributes?.booking_revision_id,
    attributes?.revision_id
  );
  const bookingId = firstString(attributes?.booking_id, attributes?.bookingId);
  const propertyId = firstString(
    attributes?.property_id,
    attributes?.propertyId
  );
  const insertedAt = firstString(
    attributes?.inserted_at,
    attributes?.insertedAt
  );

  if (!revisionId) throw new Error("CHANNEX_REVISION_MISSING_REVISION_ID");
  if (!bookingId) throw new Error("CHANNEX_REVISION_MISSING_BOOKING_ID");
  if (!propertyId) throw new Error("CHANNEX_REVISION_MISSING_PROPERTY_ID");
  if (!insertedAt) throw new Error("CHANNEX_REVISION_MISSING_INSERTED_AT");

  return {
    identity: {
      revisionId,
      bookingId,
      bookingUniqueId:
        firstString(attributes?.unique_id, attributes?.uniqueId) ?? null,
      otaReservationCode:
        firstString(
          attributes?.ota_reservation_code,
          attributes?.otaReservationCode
        ) ?? null,
      propertyId,
      liveFeedEventId:
        firstString(
          attributes?.live_feed_event_id,
          attributes?.liveFeedEventId
        ) ?? null,
      systemId:
        firstString(attributes?.system_id, attributes?.systemId) ?? null,
      insertedAt,
    },
    reservation: toCanonicalReservation(raw, bookingId),
    raw,
  };
}

function extractRevisionList(raw: any) {
  if (Array.isArray(raw?.data)) return raw.data;
  if (Array.isArray(raw)) return raw;
  return [];
}

export const channexAdapter: PmsAdapter = {
  provider: "CHANNEX",

  parseWebhook: ({ body }) => {
    const payload = payloadRoot(body);
    const payloadAttributes = payload?.attributes ?? payload;
    const eventType = normalizeWebhookEventType(
      firstString(
        body?.event,
        body?.eventType,
        body?.type,
        payload?.event,
        payload?.eventType,
        payload?.type
      )
    );
    const isBookingEvent = CHANNEX_BOOKING_EVENTS.has(
      eventType as ChannexBookingWebhookEventType
    );
    const revisionId = firstString(
      body?.booking_revision_id,
      body?.bookingRevisionId,
      body?.revision_id,
      body?.revisionId,
      body?.booking_revision?.id,
      payloadAttributes?.booking_revision_id,
      payloadAttributes?.bookingRevisionId,
      payloadAttributes?.revision_id,
      payloadAttributes?.revisionId,
      payloadAttributes?.booking_revision?.id,
      isBookingEvent ? payload?.id : null
    );
    const propertyId = firstString(
      body?.property_id,
      body?.propertyId,
      payloadAttributes?.property_id,
      payloadAttributes?.propertyId
    );
    const bookingId = firstString(
      body?.booking_id,
      body?.bookingId,
      payloadAttributes?.booking_id,
      payloadAttributes?.bookingId
    );
    const liveFeedEventId = firstString(
      body?.live_feed_event_id,
      body?.liveFeedEventId,
      payloadAttributes?.live_feed_event_id,
      payloadAttributes?.liveFeedEventId
    );
    const externalEventId = firstString(
      body?.event_id,
      body?.eventId,
      payloadAttributes?.event_id,
      payloadAttributes?.eventId,
      liveFeedEventId
    );

    return {
      eventType,
      externalEventId,
      ...(bookingId ? { externalReservationId: bookingId } : {}),
      ...(propertyId
        ? {
            bookingRevision: {
              ...(revisionId ? { revisionId } : {}),
              ...(bookingId ? { bookingId } : {}),
              bookingUniqueId:
                firstString(
                  body?.unique_id,
                  body?.uniqueId,
                  payloadAttributes?.unique_id,
                  payloadAttributes?.uniqueId
                ) ?? null,
              otaReservationCode:
                firstString(
                  body?.ota_reservation_code,
                  body?.otaReservationCode,
                  payloadAttributes?.ota_reservation_code,
                  payloadAttributes?.otaReservationCode
                ) ?? null,
              propertyId,
              liveFeedEventId: liveFeedEventId ?? null,
              systemId:
                firstString(
                  body?.system_id,
                  body?.systemId,
                  payloadAttributes?.system_id,
                  payloadAttributes?.systemId
                ) ?? null,
              insertedAt:
                firstString(
                  body?.inserted_at,
                  body?.insertedAt,
                  payloadAttributes?.inserted_at,
                  payloadAttributes?.insertedAt
                ) ?? null,
            },
          }
        : {}),
    };
  },

  fetchBookingRevision: async ({ connection, revisionId }) => {
    const response = await axios.get(
      `${getChannexBaseUrl()}/api/v1/booking_revisions/${encodeURIComponent(
        revisionId
      )}`,
      {
        headers: getChannexHeaders(connection),
        timeout: CHANNEX_REQUEST_TIMEOUT_MS,
      }
    );

    return toChannexBookingRevision(response.data);
  },

  fetchBookingRevisionFeed: async ({ connection }) => {
    const response = await axios.get(
      `${getChannexBaseUrl()}/api/v1/booking_revisions/feed`,
      {
        headers: getChannexHeaders(connection),
        params: {
          "order[inserted_at]": "asc",
        },
        timeout: CHANNEX_REQUEST_TIMEOUT_MS,
      }
    );

    return extractRevisionList(response.data).map(toChannexBookingRevision);
  },

  acknowledgeBookingRevision: async ({ connection, revisionId }) => {
    await axios.post(
      `${getChannexBaseUrl()}/api/v1/booking_revisions/${encodeURIComponent(
        revisionId
      )}/ack`,
      {},
      {
        headers: getChannexHeaders(connection),
        timeout: CHANNEX_REQUEST_TIMEOUT_MS,
      }
    );
  },
};
