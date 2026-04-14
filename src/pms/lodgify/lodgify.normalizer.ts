// src/pms/lodgify/lodgify.normalizer.ts

export type CanonicalReservationStatus = "ACTIVE" | "CANCELLED";
export type CanonicalPaymentStatus = "NONE" | "PAID" | "PENDING" | "FAILED";

export interface LodgifyGuest {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface LodgifyRoom {
  room_type_id?: number | string | null;
  guest_breakdown?: {
    adults?: number;
    children?: number;
    infants?: number;
    pets?: number;
  } | null;
  people?: number | null;
  key_code?: string | null;
}

export interface LodgifyBooking {
  id: number | string;
  arrival?: string | null;
  departure?: string | null;
  property_id?: number | string | null;
  rooms?: LodgifyRoom[] | null;
  guest?: LodgifyGuest | null;
  status?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  canceled_at?: string | null;
  is_deleted?: boolean | null;
  currency_code?: string | null;
  total_amount?: number | string | null;
  amount_paid?: number | string | null;
  amount_due?: number | string | null;
  notes?: string | null;
  [key: string]: unknown;
}

export interface LodgifyNormalizedReservation {
  externalReservationId: string;
  externalListingId: string;
  guestName: string | null;
  guestEmail: string | null;
  guestPhone: string | null;
  checkIn: string | null;
  checkOut: string | null;
  externalUpdatedAt: string | null;
  status: CanonicalReservationStatus;
  paymentStatus: CanonicalPaymentStatus;
  externalRaw: LodgifyBooking;
}

function asTrimmedString(value: unknown): string | null {
  if (value == null) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeStatus(input: LodgifyBooking): CanonicalReservationStatus {
  const raw = String(input.status ?? "").trim().toLowerCase();

  // Confirmado por ti:
  // Booked => ACTIVE
  // Declined => CANCELLED
  if (raw === "declined") return "CANCELLED";

  // Protección extra sin romper el mapping principal.
  if (raw === "cancelled" || raw === "canceled") return "CANCELLED";
  if (input.is_deleted === true) return "CANCELLED";

  return "ACTIVE";
}

function normalizePaymentStatus(input: LodgifyBooking): CanonicalPaymentStatus {
  const total = asNumber(input.total_amount) ?? 0;
  const paid = asNumber(input.amount_paid) ?? 0;
  const due = asNumber(input.amount_due);

  if (total <= 0 && paid <= 0) return "NONE";
  if (paid >= total && total > 0) return "PAID";

  if (due != null) {
    if (due <= 0 && total > 0) return "PAID";
    if (due > 0) return "PENDING";
  }

  if (paid > 0 && paid < total) return "PENDING";
  if (paid <= 0 && total > 0) return "PENDING";

  return "NONE";
}

function normalizeDate(value: unknown): string | null {
  const raw = asTrimmedString(value);
  if (!raw) return null;

  // Lodgify arrival/departure vienen como fecha YYYY-MM-DD.
  // No los forzamos a datetime para no romper tu ingest actual.
  return raw;
}

function normalizeUpdatedAt(value: unknown): string | null {
  const raw = asTrimmedString(value);
  if (!raw) return null;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return raw;
  }

  return date.toISOString();
}

export function normalizeLodgifyBooking(
  booking: LodgifyBooking
): LodgifyNormalizedReservation {
  const externalReservationId = asTrimmedString(booking.id);
  if (!externalReservationId) {
    throw new Error("Lodgify booking missing id");
  }

  const externalListingId =
    asTrimmedString(booking.property_id) ??
    asTrimmedString(booking.rooms?.[0]?.room_type_id) ??
    "";

  if (!externalListingId) {
    throw new Error(
      `Lodgify booking ${externalReservationId} missing property_id/room_type_id`
    );
  }

  return {
    externalReservationId,
    externalListingId,
    guestName: asTrimmedString(booking.guest?.name),
    guestEmail: asTrimmedString(booking.guest?.email),
    guestPhone: asTrimmedString(booking.guest?.phone),
    checkIn: normalizeDate(booking.arrival),
    checkOut: normalizeDate(booking.departure),
    externalUpdatedAt: normalizeUpdatedAt(booking.updated_at),
    status: normalizeStatus(booking),
    paymentStatus: normalizePaymentStatus(booking),
    externalRaw: booking,
  };
}

export default normalizeLodgifyBooking;