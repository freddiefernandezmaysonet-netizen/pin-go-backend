import { isGuestOperationalSmsEligible } from "./guest-journey-access-communications-bridge.policy";

export type FirstPrecheckinReservation = {
  source: string | null; externalProvider: string | null; externalId: string | null;
  status: string; paymentState: string; cancelledAt: Date | null;
  createdAt: Date; checkIn: Date; checkOut: Date;
  guestEmail: string | null; guestPhone: string | null; externalRaw: unknown;
};

/** First-send contract initially invoked only by the isolated lab. Preserves
 * legacy SMS catch-up and the distinct email window; OTA retains its owner. */
export function firstPrecheckinBlockReason(r: FirstPrecheckinReservation, channel: "sms" | "email", now: Date): string | null {
  if (![now, r.createdAt, r.checkIn, r.checkOut].every(d => d instanceof Date && Number.isFinite(d.getTime())) || r.checkIn >= r.checkOut)
    return "INVALID_DATES";
  if (r.source !== "DIRECT_BOOKING" || (r.externalProvider ? r.externalProvider !== "PIN_GO_DIRECT" : Boolean(r.externalId)))
    return "EXTERNAL_OWNER_REQUIRED";
  if (r.status !== "ACTIVE" || r.cancelledAt) return "RESERVATION_INACTIVE";
  if (r.paymentState !== "PAID") return "PAYMENT_NOT_READY";
  if (now >= r.checkOut) return "STAY_ENDED";
  if (r.checkIn.getTime() - now.getTime() > 4 * 3600000) return "NOT_DUE";
  if (channel === "email") {
    if (now >= r.checkIn && r.createdAt < r.checkIn) return "EMAIL_WINDOW_CLOSED";
    if (!r.guestEmail?.trim()) return "EMAIL_MISSING";
  } else {
    if (!r.guestPhone?.trim()) return "PHONE_MISSING";
    if (!isGuestOperationalSmsEligible(r)) return "SMS_NOT_ELIGIBLE";
  }
  return null;
}
