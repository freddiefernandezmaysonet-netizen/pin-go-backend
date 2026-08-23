export const CHANNEX_BOOKING_INGEST_MECHANISMS = [
  "BOOKING_REVISION_BY_ID",
  "BOOKING_REVISION_FEED",
] as const;

export type ChannexBookingIngestMechanism =
  (typeof CHANNEX_BOOKING_INGEST_MECHANISMS)[number];

const ALLOWED_MECHANISMS = new Set<string>(
  CHANNEX_BOOKING_INGEST_MECHANISMS
);

const FORBIDDEN_BOOKING_FIND_MECHANISMS = new Set([
  "BOOKING_FIND",
  "BOOKING_BY_ID",
  "BOOKING_LIST",
  "BOOKING_LIST_POLLING",
  "BOOKING_RECEIVED_VIA_BOOKING_FIND",
]);

function normalize(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

export function requireAllowedChannexBookingIngestMechanism(
  value: unknown
): ChannexBookingIngestMechanism {
  const mechanism = normalize(value);

  if (FORBIDDEN_BOOKING_FIND_MECHANISMS.has(mechanism)) {
    throw new Error(`CHANNEX_BOOKING_FIND_FORBIDDEN:${mechanism}`);
  }

  if (!ALLOWED_MECHANISMS.has(mechanism)) {
    throw new Error(
      `CHANNEX_BOOKING_INGEST_MECHANISM_UNSUPPORTED:${mechanism || "MISSING"}`
    );
  }

  return mechanism as ChannexBookingIngestMechanism;
}
