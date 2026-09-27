import { createHash } from "node:crypto";
import { Prisma, type Reservation } from "@prisma/client";

// Deliberately conservative: only the watchdog's bookkeeping and its automatic
// timestamp are excluded. Every other scalar (including future schema fields)
// remains protected. Relations are validated separately by the canonical flow.
const bookkeeping = new Set<string>([
  "updatedAt", "lastReconciledAt", "lastReconciledCheckIn", "lastReconciledCheckOut",
]);

function canonical(value: unknown): unknown {
  if (value === undefined) return { missing: true };
  if (value instanceof Date) return value.toISOString();
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function reservationStateFingerprint(reservation: Reservation): string {
  const fields = Object.values(Prisma.ReservationScalarFieldEnum)
    .filter(field => !bookkeeping.has(field)).sort();
  return createHash("sha256").update(JSON.stringify({
    version: "pin_ai_reservation_state_v1",
    fields: fields.map(field => [field, canonical(reservation[field])]),
  })).digest("hex");
}

/** Legacy quotes deliberately keep the original updatedAt guard. */
export function extensionStateFingerprint(terms: unknown): string | null {
  if (!terms || typeof terms !== "object" || Array.isArray(terms)) return null;
  const value = terms as Record<string, unknown>;
  return value.operation === "EXTEND_CHECKOUT_ONLY" &&
    typeof value.reservationStateFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(value.reservationStateFingerprint)
    ? value.reservationStateFingerprint : null;
}
