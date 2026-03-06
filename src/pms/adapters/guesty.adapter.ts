import type { PmsAdapter, CanonicalReservation } from "./types";
import axios from "axios";

const GUESTY_BASE_URL = "https://open-api.guesty.com/v1";

/**
 * V1: asumimos que credentialsEncrypted contiene accessToken.
 * Ejemplo (sin cifrar por ahora):
 * {
 *   "accessToken": "xxx"
 * }
 *
 * Cuando tengas clientId/clientSecret, lo extendemos para hacer token exchange y refresh.
 */
function getAccessTokenOrThrow(connection: { credentialsEncrypted?: string | null }) {
  if (!connection.credentialsEncrypted) throw new Error("GUESTY_NO_CREDENTIALS");
  let creds: any;
  try {
    creds = JSON.parse(connection.credentialsEncrypted);
  } catch {
    throw new Error("GUESTY_BAD_CREDENTIALS_JSON");
  }
  if (!creds.accessToken) throw new Error("GUESTY_NO_ACCESS_TOKEN");
  return String(creds.accessToken);
}

/**
 * Mapea la respuesta real de Guesty a tu CanonicalReservation.
 * Nota: algunos paths pueden variar según el payload que veas.
 * Ajustamos cuando hagas el primer fetch real.
 */
function mapGuestyReservationToCanonical(externalReservationId: string, r: any): CanonicalReservation {
  const externalListingId =
    r?.listingId ?? r?.listing?._id ?? r?.listing?.id ?? r?.propertyId ?? r?.property?._id ?? r?.property?.id;

  // Guesty puede traer fechas con distintos nombres; dejamos varios fallbacks.
  const checkInRaw = r?.checkIn ?? r?.checkInDate ?? r?.checkInDateLocalized ?? r?.startDate;
  const checkOutRaw = r?.checkOut ?? r?.checkOutDate ?? r?.checkOutDateLocalized ?? r?.endDate;

  // Guest info
  const guestName =
    r?.guest?.fullName ??
    [r?.guest?.firstName, r?.guest?.lastName].filter(Boolean).join(" ") ??
    r?.guestName;
    
  const listingName =
    r?.listing?.title ?? r?.listing?.nickname ?? r?.listingTitle ?? null;

  // Status (ajustaremos cuando veas el enum exacto)
  const status: CanonicalReservation["status"] =
    String(r?.status ?? "").toLowerCase() === "cancelled" ? "CANCELLED" : "CONFIRMED";

  if (!externalListingId) throw new Error("GUESTY_RESERVATION_MISSING_LISTING_ID");
  if (!checkInRaw || !checkOutRaw) throw new Error("GUESTY_RESERVATION_MISSING_DATES");

  return {
    provider: "GUESTY",
    externalReservationId,
    externalListingId: String(externalListingId),
    status,
    checkIn: new Date(checkInRaw).toISOString(),
    checkOut: new Date(checkOutRaw).toISOString(),
    listingName,
    timezone: r?.timezone ?? r?.listing?.timezone,
    guest: {
      name: guestName,
      email: r?.guest?.email ?? r?.guestEmail,
      phone: r?.guest?.phone ?? r?.guestPhone,
    },
    notes: r?.notes ?? r?.guestNote,
  };
}

export const guestyAdapter: PmsAdapter = {
  provider: "GUESTY",

  parseWebhook: ({ body }) => {
    const eventType = body?.eventType ?? body?.event ?? "RESERVATION";
    const externalEventId = body?.externalEventId ?? body?.id ?? null;

    // ✅ MODO TEST: si viene reservation ya normalizada
    if (
      body?.reservation?.externalReservationId &&
      body?.reservation?.externalListingId
    ) {
      return {
        eventType,
        externalEventId,
        reservation: body.reservation as CanonicalReservation,
      };
    }

    // ✅ FALLBACK: si viene solo reservationId
    const externalReservationId =
      body?.reservationId ??
      body?.reservation_id ??
      body?.data?.reservationId ??
      body?.data?.reservation_id ??
      body?.reservation?._id ??
      body?.reservation?.id;

    return {
      eventType,
      externalEventId,
      externalReservationId,
    };
  },

  /**
   * ✅ MODO REAL:
   * Webhook trae solo reservationId → hacemos GET /reservations/:id
   */
  fetchReservation: async ({ connection, externalReservationId }) => {
    //const accessToken = getAccessTokenOrThrow(connection);
    // const resp = await axios.get(...);
    const url = `${GUESTY_BASE_URL}/reservations/${encodeURIComponent(externalReservationId)}`;

// 🔥 MOCK TEMPORAL (solo para probar flujo real)
const suffix = String(externalReservationId).slice(-4);
const listingId = `L-${suffix}`;

const payload = {
  id: externalReservationId,
  listingId,
  listing: {
    title: `Listing ${listingId}`,
    nickname: `Listing ${listingId}`,
  },
  checkIn: "2026-02-25T22:50:41.960Z",
  checkOut: "2026-02-26T22:46:41.960Z",                        
  status: "cancelled",                             
  guest: {
    fullName: "Mock Guest",
    email: "mock@test.com",
    phone: "+123456789",
  },
};

       // Dependiendo del wrapper de Guesty, puede venir en resp.data o resp.data.data
    //const payload = resp.data?.data ?? resp.data;

    return mapGuestyReservationToCanonical(externalReservationId, payload);
  },
};