import crypto from "crypto";
import axios from "axios";
import type { PmsAdapter, CanonicalReservation } from "./types";

const LODGIFY_BOOKINGS_URL = "https://api.lodgify.com/v2/reservations/bookings";

function getEncryptionKey() {
  const secret = process.env.PMS_CREDENTIALS_SECRET ?? "";
  if (!secret) {
    throw new Error("PMS_CREDENTIALS_SECRET not configured");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

function decryptJson(payload: string) {
  const parsed = JSON.parse(payload ?? "{}");

  if (
    !parsed ||
    parsed.alg !== "aes-256-gcm" ||
    !parsed.iv ||
    !parsed.tag ||
    !parsed.data
  ) {
    throw new Error("INVALID_ENCRYPTED_PMS_CREDENTIALS");
  }

  const key = getEncryptionKey();
  const iv = Buffer.from(parsed.iv, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  const data = Buffer.from(parsed.data, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]).toString("utf8");

  return JSON.parse(decrypted);
}

function asTrimmedString(value: unknown): string | null {
  if (value == null) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

/**
 * Regla crítica:
 * - Si Lodgify trae fecha simple YYYY-MM-DD, NO convertir a Date/ISO.
 *   Se deja pasar tal cual para que webhook.processor aplique:
 *   - checkInTime de Property
 *   - checkOut fijo de negocio
 * - Si el PMS algún día trae datetime real con "T", se respeta tal cual.
 */
function normalizePmsDate(value: unknown): string | null {
  const raw = asTrimmedString(value);
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  if (raw.includes("T")) {
    return raw;
  }

  return raw;
}

function mapLodgifyReservationToCanonical(
  externalReservationId: string,
  r: any
): CanonicalReservation {
  const externalListingId =
    r?.property_id ??
    r?.propertyId ??
    r?.room_id ??
    r?.listing_id ??
    r?.listingId;

  const checkInRaw =
    r?.arrival ??
    r?.checkIn ??
    r?.start_date ??
    r?.startDate;

  const checkOutRaw =
    r?.departure ??
    r?.checkOut ??
    r?.end_date ??
    r?.endDate;

  const guestName =
    r?.guest_name ??
    r?.guest?.name ??
    [r?.guest?.first_name, r?.guest?.last_name].filter(Boolean).join(" ") ??
    null;

  const rawStatus = String(r?.status ?? "").toLowerCase();

  const status: CanonicalReservation["status"] =
    ["cancelled", "canceled", "declined"].includes(rawStatus)      
      ? "CANCELLED"
      : "CONFIRMED";

  if (!externalListingId) {
    throw new Error("LODGIFY_RESERVATION_MISSING_LISTING_ID");
  }

  if (!checkInRaw || !checkOutRaw) {
    throw new Error("LODGIFY_RESERVATION_MISSING_DATES");
  }

  const normalizedCheckIn = normalizePmsDate(checkInRaw);
  const normalizedCheckOut = normalizePmsDate(checkOutRaw);

  if (!normalizedCheckIn || !normalizedCheckOut) {
    throw new Error("LODGIFY_RESERVATION_INVALID_DATES");
  }

  return {
    provider: "LODGIFY",
    externalReservationId: String(externalReservationId),
    externalListingId: String(externalListingId),
    listingName:
      r?.property_name ??
      r?.property?.name ??
      r?.listing_name ??
      r?.room_name ??
      null,
    status,
    checkIn: normalizedCheckIn,
    checkOut: normalizedCheckOut,
    timezone:
      r?.timezone ??
      r?.property_timezone ??
      undefined,
    guest: {
      name: guestName,
      email: r?.guest_email ?? r?.guest?.email ?? null,
      phone: r?.guest_phone ?? r?.guest?.phone ?? null,
    },
    party: {
      adults:
        typeof r?.adults === "number"
          ? r.adults
          : typeof r?.guest_adults === "number"
          ? r.guest_adults
          : undefined,
      children:
        typeof r?.children === "number"
          ? r.children
          : typeof r?.guest_children === "number"
          ? r.guest_children
          : undefined,
    },
    notes: r?.notes ?? r?.internal_notes ?? null,
    raw: r,
  };
}

function extractBookingsArray(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.bookings)) return payload.bookings;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

export const lodgifyAdapter: PmsAdapter = {
  provider: "LODGIFY",

  parseWebhook: ({ body }) => {
    const eventType =
      body?.event ??
      body?.eventType ??
      body?.type ??
      "RESERVATION";

    const externalEventId =
      body?.id ??
      body?.eventId ??
      null;

    const reservation =
      body?.reservation ??
      body?.data ??
      body;

    const externalReservationId =
      reservation?.id ??
      reservation?.booking_id ??
      reservation?.reservation_id ??
      null;

    if (
      externalReservationId &&
      reservation?.arrival &&
      reservation?.departure
    ) {
      return {
        eventType,
        externalEventId,
        reservation: mapLodgifyReservationToCanonical(
          externalReservationId,
          reservation
        ),
      };
    }

    return {
      eventType,
      externalEventId,
      externalReservationId: externalReservationId
        ? String(externalReservationId)
        : undefined,
    };
  },

  fetchReservation: async ({ connection, externalReservationId }) => {
    if (!connection.credentialsEncrypted) {
      throw new Error("LODGIFY_MISSING_CREDENTIALS");
    }

    const creds = decryptJson(connection.credentialsEncrypted);
    const apiKey = String(creds?.apiKey ?? "").trim();

    if (!apiKey) {
      throw new Error("LODGIFY_API_KEY_MISSING");
    }

    const resp = await axios.get(LODGIFY_BOOKINGS_URL, {
      headers: {
        "X-ApiKey": apiKey,
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; PinGo/1.0)",
      },
      params: {
        includeGuest: true,
      },
      timeout: 20000,
    });

    console.log("[lodgify] bookings response", JSON.stringify(resp.data, null, 2));
    const bookings = extractBookingsArray(resp.data);

    const found = bookings.find((item: any) => {
      const id =
        item?.id ??
        item?.booking_id ??
        item?.reservation_id;
      return String(id ?? "") === String(externalReservationId);
    });

    if (!found) {
      throw new Error(
        `LODGIFY_RESERVATION_NOT_FOUND_${externalReservationId}`
      );
    }

    return mapLodgifyReservationToCanonical(
      String(
        found?.id ??
          found?.booking_id ??
          found?.reservation_id ??
          externalReservationId
      ),
      found
    );
  },
};