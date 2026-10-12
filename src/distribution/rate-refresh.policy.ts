import { createHash } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import { requireIanaTimezone } from "../lib/iana-timezone.js";
import { addUtcDays, assertDateKey, CHANNEX_ARI_FULL_SYNC_DAYS } from "../pms/outbound/channex-ari-lifecycle.policy.js";

export const RATE_REFRESH_TRIGGER = "DISTRIBUTION_RATE_REFRESH_V1";
export const RATE_REFRESH_SOURCE = "RATE_REFRESH_SNAPSHOT_V1";

export type RateRefreshProperty = {
  id: string;
  organizationId: string;
  timezone: string | null;
  dynamicPricingEnabled: boolean;
  occupancyPricingEnabled: boolean;
  occupancyLookaheadDays: number;
  leadTimePricingEnabled: boolean;
};
export type RateRefreshSnapshot = {
  version: 1;
  localDay: string;
  utcDay: string;
  occupiedNights: number;
  configHash: string;
};
export type RateRefreshPlan = {
  snapshot: RateRefreshSnapshot;
  sourceEntityId: string;
  rateFields: Array<"rate" | "minStayArrival" | "minStayThrough" | "maxStay">;
  rateRange: { dateFrom: string; dateToExclusive: string };
  availabilityRange: { dateFrom: string; dateToExclusive: string } | null;
  changed: boolean;
};

export function readRateRefreshSnapshot(raw: string | null): RateRefreshSnapshot | null {
  if (raw === null) return null;
  try {
    const s = JSON.parse(raw) as RateRefreshSnapshot;
    if (s.version !== 1 || !Number.isSafeInteger(s.occupiedNights) || s.occupiedNights < 0 ||
        !/^[a-f0-9]{64}$/.test(s.configHash)) throw Error();
    assertDateKey(s.localDay, "local_day");
    assertDateKey(s.utcDay, "utc_day");
    return s;
  } catch { throw new Error("DISTRIBUTION_RATE_REFRESH_LEDGER_INVALID"); }
}

export function buildRateRefreshPlan(input: {
  property: RateRefreshProperty;
  rateConfiguration: Record<string, unknown>;
  reservations: Array<{ checkIn: Date; checkOut: Date }>;
  previous: RateRefreshSnapshot | null;
  now: Date;
}): RateRefreshPlan {
  if (!Number.isFinite(input.now.getTime())) throw new Error("DISTRIBUTION_RATE_REFRESH_TIME_INVALID");
  const timezone = requireIanaTimezone(input.property.timezone);
  const localDay = formatInTimeZone(input.now, timezone, "yyyy-MM-dd");
  const utcDay = input.now.toISOString().slice(0, 10);
  const dateToExclusive = addUtcDays(localDay, CHANNEX_ARI_FULL_SYNC_DAYS);
  const occupancyEnabled = input.property.dynamicPricingEnabled && input.property.occupancyPricingEnabled;
  const occupied = new Set<string>();
  const lookahead = input.property.occupancyLookaheadDays;
  // Match Revenue's current UTC-day occupancy calculation and its ARI query
  // horizon. Never change the pricing formula here; this is only a producer.
  if (occupancyEnabled && Number.isSafeInteger(lookahead) && lookahead > 0) {
    const occupancyEnd = addUtcDays(utcDay, Math.min(lookahead, CHANNEX_ARI_FULL_SYNC_DAYS));
    for (const reservation of input.reservations) {
      if (!Number.isFinite(reservation.checkIn.getTime()) || !Number.isFinite(reservation.checkOut.getTime())) {
        throw new Error("DISTRIBUTION_RATE_REFRESH_RESERVATION_TIME_INVALID");
      }
      const start = reservation.checkIn.toISOString().slice(0, 10);
      const end = reservation.checkOut.toISOString().slice(0, 10);
      for (let day = start > utcDay ? start : utcDay; day < end && day < occupancyEnd && day < dateToExclusive; day = addUtcDays(day, 1)) {
        occupied.add(day);
      }
    }
  }
  const configHash = createHash("sha256")
    .update(JSON.stringify(Object.entries(input.rateConfiguration).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex");
  const snapshot: RateRefreshSnapshot = { version: 1, localDay, utcDay, occupiedNights: occupied.size, configHash };
  const p = input.previous;
  const daily = !p || p.localDay !== localDay;
  const timeSensitive = input.property.dynamicPricingEnabled &&
    (input.property.leadTimePricingEnabled || input.property.occupancyPricingEnabled);
  const changed = daily || p.configHash !== configHash || p.occupiedNights !== occupied.size ||
    (timeSensitive && p.utcDay !== utcDay);
  let availabilityRange: RateRefreshPlan["availabilityRange"] = null;
  if (daily) {
    // Bootstrap repairs the whole horizon. Later days only replenish the newly
    // exposed tail, including missed days after downtime. A timezone change
    // that moves the local date backwards revalidates the current horizon.
    const priorEnd = p && p.localDay < localDay ? addUtcDays(p.localDay, CHANNEX_ARI_FULL_SYNC_DAYS) : localDay;
    availabilityRange = { dateFrom: priorEnd > localDay ? priorEnd : localDay, dateToExclusive };
  }
  return {
    snapshot, sourceEntityId: JSON.stringify(snapshot), changed,
    rateFields: daily ? ["rate", "minStayArrival", "minStayThrough", "maxStay"] : ["rate"],
    rateRange: { dateFrom: localDay, dateToExclusive }, availabilityRange,
  };
}

export function resolveRateRefreshConfig(env: Readonly<Record<string, string | undefined>>) {
  const value = (env.DISTRIBUTION_RATE_REFRESH_ENABLED ?? "false").trim().toLowerCase();
  if (value !== "true" && value !== "false") throw new Error("DISTRIBUTION_RATE_REFRESH_ENABLED_INVALID");
  const pollMs = Number(env.DISTRIBUTION_RATE_REFRESH_POLL_MS ?? "60000");
  if (!Number.isSafeInteger(pollMs) || pollMs < 10000 || pollMs > 300000) {
    throw new Error("DISTRIBUTION_RATE_REFRESH_POLL_MS_INVALID");
  }
  return { enabled: value === "true", pollMs };
}
