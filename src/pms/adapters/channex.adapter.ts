import crypto from "crypto";
import axios from "axios";
import type { CanonicalReservation, PmsAdapter } from "./types";

const CHANNEX_API_BASE_URL =
  process.env.CHANNEX_API_BASE_URL ?? "https://staging.channex.io";

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

function getChannexApiKey(connection: {
  credentialsEncrypted?: string | null;
}) {
  if (connection.credentialsEncrypted) {
    const creds = decryptJson(connection.credentialsEncrypted);
    const apiKey = asString(creds?.apiKey);
    if (apiKey) return apiKey;
  }

  const envApiKey = asString(process.env.CHANNEX_API_KEY);
  if (envApiKey) return envApiKey;

  throw new Error("CHANNEX_NO_API_KEY");
}

function payloadRoot(body: any) {
  return body?.payload ?? body?.data ?? body;
}

function normalizeStatus(value: unknown): CanonicalReservation["status"] {
  const status = String(value ?? "").toUpperCase();

  if (["CANCELLED", "CANCELED"].includes(status)) return "CANCELLED";
  if (["INQUIRY"].includes(status)) return "INQUIRY";
  if (["HOLD", "HELD"].includes(status)) return "HOLD";

  return "CONFIRMED";
}

function extractBooking(raw: any) {
  const data = raw?.data ?? raw;
  const attributes = data?.attributes ?? data;

  return (
    attributes?.booking ??
    attributes?.reservation ??
    attributes?.revision ??
    attributes ??
    data
  );
}

function toCanonicalReservation(raw: any, fallbackId: string): CanonicalReservation {
  const booking = extractBooking(raw);

  const externalReservationId =
    firstString(
      booking?.booking_id,
      booking?.bookingId,
      booking?.reservation_id,
      booking?.reservationId,
      booking?.unique_id,
      booking?.id,
      raw?.data?.id,
      fallbackId
    ) ?? fallbackId;

  const externalListingId =
    firstString(
      booking?.listing_id,
      booking?.listingId,
      booking?.property_id,
      booking?.propertyId,
      booking?.room_type_id,
      booking?.roomTypeId,
      booking?.room_id,
      booking?.roomId
    );

  if (!externalListingId) {
    throw new Error("CHANNEX_MISSING_EXTERNAL_LISTING_ID");
  }

  const checkIn =
    firstString(
      booking?.check_in,
      booking?.checkIn,
      booking?.arrival_date,
      booking?.arrivalDate
    );

  const checkOut =
    firstString(
      booking?.check_out,
      booking?.checkOut,
      booking?.departure_date,
      booking?.departureDate
    );

  if (!checkIn || !checkOut) {
    throw new Error("CHANNEX_MISSING_DATES");
  }

  return {
    provider: "CHANNEX",
    externalReservationId,
    externalListingId,
    listingName:
      firstString(
        booking?.listing_name,
        booking?.listingName,
        booking?.property_name,
        booking?.propertyName,
        booking?.room_type_name,
        booking?.roomTypeName
      ) ?? null,
    status: normalizeStatus(
      booking?.status ?? booking?.booking_status ?? booking?.state
    ),
    checkIn,
    checkOut,
    timezone: firstString(booking?.timezone, booking?.time_zone) ?? undefined,
    guest: {
      name:
        firstString(
          booking?.guest_name,
          booking?.guestName,
          booking?.customer?.name,
          booking?.guest?.name
        ) ?? undefined,
      email:
        firstString(
          booking?.guest_email,
          booking?.guestEmail,
          booking?.customer?.email,
          booking?.guest?.email
        ) ?? undefined,
      phone:
        firstString(
          booking?.guest_phone,
          booking?.guestPhone,
          booking?.customer?.phone,
          booking?.guest?.phone
        ) ?? undefined,
    },
    party: {
      adults: Number(booking?.adults ?? booking?.occupancy?.adults ?? 0) || undefined,
      children:
        Number(booking?.children ?? booking?.occupancy?.children ?? 0) || undefined,
    },
    notes: firstString(booking?.notes, booking?.remarks, booking?.special_request) ?? undefined,
    raw: booking,
  };
}

export const channexAdapter: PmsAdapter = {
  provider: "CHANNEX",

  parseWebhook: ({ body }) => {
    const payload = payloadRoot(body);

    const eventType =
      firstString(
        body?.event,
        body?.eventType,
        body?.type,
        payload?.event,
        payload?.eventType,
        payload?.type
      ) ?? "BOOKING";

    const externalEventId = firstString(
      body?.id,
      body?.eventId,
      body?.event_id,
      payload?.id,
      payload?.eventId,
      payload?.event_id
    );

    const externalReservationId = firstString(
      body?.booking_revision_id,
      body?.bookingRevisionId,
      body?.booking_revision?.id,
      payload?.booking_revision_id,
      payload?.bookingRevisionId,
      payload?.booking_revision?.id,
      body?.booking_id,
      body?.bookingId,
      body?.reservation_id,
      body?.reservationId,
      body?.unique_id,
      payload?.booking_id,
      payload?.bookingId,
      payload?.reservation_id,
      payload?.reservationId,
      payload?.unique_id,
      payload?.booking?.id,
      payload?.booking?.booking_id,
      payload?.booking?.unique_id,
      payload?.reservation?.id,
      payload?.reservation?.booking_id,
      payload?.reservation?.unique_id
    );

    return {
      eventType,
      externalEventId,
      externalReservationId: externalReservationId ?? undefined,
    };
  },

  fetchReservation: async ({ connection, externalReservationId }) => {
    const apiKey = getChannexApiKey(connection);
    const baseUrl = CHANNEX_API_BASE_URL.replace(/\/+$/, "");

    const resp = await axios.get(
      `${baseUrl}/api/v1/booking_revisions/${externalReservationId}`,
      {
        headers: {
          Accept: "application/json",
          "user-api-key": apiKey,
        },
        timeout: 15000,
      }
    );

    return toCanonicalReservation(resp.data, externalReservationId);
  },
};