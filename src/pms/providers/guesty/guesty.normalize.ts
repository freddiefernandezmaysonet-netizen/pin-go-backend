import {
  registerReservationNormalizer,
} from "../../normalizer/reservation.normalizer";

import {
  NormalizedReservation,
  ReservationNormalizerContext,
} from "../../normalizer/reservation.normalizer.types";

/**
 * Traduce payloads de Guesty al formato interno de Pin&Go
 */
async function normalizeGuestyReservation(
  ctx: ReservationNormalizerContext
): Promise<NormalizedReservation> {

  const payload: any = ctx.payload;

  const reservation = payload?.reservation ?? payload;

  if (!reservation) {
    throw new Error("GUESTY_PAYLOAD_MISSING_RESERVATION");
  }

  const externalReservationId =
    reservation._id ??
    reservation.id ??
    reservation.reservationId;

  if (!externalReservationId) {
    throw new Error("GUESTY_RESERVATION_ID_MISSING");
  }

  const externalListingId =
    reservation.listing?._id ??
    reservation.listingId ??
    reservation.listing?.id ??
    null;

  const guest =
    reservation.guest ??
    reservation.primaryGuest ??
    null;

  const guestName =
    guest?.fullName ??
    guest?.name ??
    reservation.guestName ??
    null;

  const guestEmail =
    guest?.email ??
    reservation.guestEmail ??
    null;

  const guestPhone =
    guest?.phone ??
    reservation.guestPhone ??
    null;

  const checkIn =
    reservation.checkIn ??
    reservation.arrivalDate ??
    reservation.startDate;

  const checkOut =
    reservation.checkOut ??
    reservation.departureDate ??
    reservation.endDate;

  if (!checkIn || !checkOut) {
    throw new Error("GUESTY_RESERVATION_DATES_MISSING");
  }

  const status = normalizeStatus(reservation.status);

  const paymentState = normalizePaymentState(
    reservation.paymentStatus ??
    reservation.paymentState
  );

  return {
    provider: "GUESTY",

    externalReservationId: String(externalReservationId),

    externalListingId:
      externalListingId ? String(externalListingId) : null,

    guestName,
    guestEmail,
    guestPhone,

    checkIn: new Date(checkIn).toISOString(),
    checkOut: new Date(checkOut).toISOString(),

    status,

    paymentState,

    rawEventType: ctx.eventType ?? null,

    rawUpdatedAt:
      reservation.updatedAt ??
      reservation.lastModified ??
      null,

    notes: reservation.notes ?? null,
  };
}

/**
 * Traduce estados Guesty → estado interno
 */
function normalizeStatus(status: any): "ACTIVE" | "CANCELLED" {

  const s = String(status ?? "").toLowerCase();

  if (
    s === "cancelled" ||
    s === "canceled"
  ) {
    return "CANCELLED";
  }

  return "ACTIVE";
}

/**
 * Traduce estados de pago
 */
function normalizePaymentState(
  state: any
): "PAID" | "UNPAID" | "PARTIAL" | "UNKNOWN" {

  const s = String(state ?? "").toLowerCase();

  if (s === "paid") return "PAID";

  if (s === "partial") return "PARTIAL";

  if (s === "unpaid") return "UNPAID";

  return "UNKNOWN";
}

/**
 * Registro del adaptador Guesty
 */
registerReservationNormalizer(
  "GUESTY",
  normalizeGuestyReservation
);