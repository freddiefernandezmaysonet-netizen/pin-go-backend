import crypto from "node:crypto";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import {
  CHANNEX_ARI_FULL_SYNC_DAYS,
  addUtcDays,
  assertDateKey,
  assertPayloadWithinLimit,
  normalizeDateKeys,
} from "./channex-ari-lifecycle.policy";

export type ChannexAriAvailabilityRange = {
  startsAt: Date;
  endsAt: Date;
};

export type ChannexAriAvailabilityValue = {
  property_id: string;
  room_type_id: string;
  date: string;
  availability: 0 | 1;
};

export type ChannexAriAvailabilityPayload = {
  values: ChannexAriAvailabilityValue[];
};

export type ChannexAriAvailabilitySnapshot = {
  payload: ChannexAriAvailabilityPayload;
  payloadHash: string;
  payloadBytes: number;
  payloadValueCount: number;
  dateFrom: string;
  dateToExclusive: string;
  unavailableDateKeys: string[];
};

function requireText(value: unknown, errorCode: string): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(errorCode);
  }

  return normalized;
}

function assertValidTimezone(timezone: string): string {
  const normalized = requireText(
    timezone,
    "CHANNEX_ARI_PROPERTY_TIMEZONE_REQUIRED"
  );

  try {
    formatInTimeZone(
      new Date("2026-01-01T00:00:00.000Z"),
      normalized,
      "yyyy-MM-dd"
    );
  } catch {
    throw new Error("CHANNEX_ARI_PROPERTY_TIMEZONE_INVALID");
  }

  return normalized;
}

function normalizeRanges(
  ranges: ChannexAriAvailabilityRange[],
  source: "RESERVATION" | "BLOCK"
): ChannexAriAvailabilityRange[] {
  return ranges.map((range, index) => {
    const startsAt = new Date(range.startsAt);
    const endsAt = new Date(range.endsAt);

    if (Number.isNaN(startsAt.getTime())) {
      throw new Error(`CHANNEX_ARI_${source}_${index}_START_INVALID`);
    }

    if (Number.isNaN(endsAt.getTime())) {
      throw new Error(`CHANNEX_ARI_${source}_${index}_END_INVALID`);
    }

    if (endsAt <= startsAt) {
      throw new Error(`CHANNEX_ARI_${source}_${index}_RANGE_INVALID`);
    }

    return { startsAt, endsAt };
  });
}

function buildLocalNightInterval(dateKey: string, timezone: string) {
  const from = assertDateKey(dateKey);
  const toExclusive = addUtcDays(from, 1);

  const startsAt = fromZonedTime(`${from}T00:00:00`, timezone);
  const endsAt = fromZonedTime(`${toExclusive}T00:00:00`, timezone);

  if (
    Number.isNaN(startsAt.getTime()) ||
    Number.isNaN(endsAt.getTime()) ||
    endsAt <= startsAt
  ) {
    throw new Error("CHANNEX_ARI_LOCAL_NIGHT_INTERVAL_INVALID");
  }

  return { startsAt, endsAt };
}

function overlaps(
  night: ChannexAriAvailabilityRange,
  occupied: ChannexAriAvailabilityRange
): boolean {
  return occupied.startsAt < night.endsAt && occupied.endsAt > night.startsAt;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

export function buildChannexAriAvailabilitySnapshot(input: {
  channexPropertyId: string;
  channexRoomTypeId: string;
  propertyTimezone: string;
  dateKeys: string[];
  activeReservationRanges?: ChannexAriAvailabilityRange[];
  blockedRanges?: ChannexAriAvailabilityRange[];
}): ChannexAriAvailabilitySnapshot {
  const channexPropertyId = requireText(
    input.channexPropertyId,
    "CHANNEX_ARI_CHANNEX_PROPERTY_ID_REQUIRED"
  );
  const channexRoomTypeId = requireText(
    input.channexRoomTypeId,
    "CHANNEX_ARI_CHANNEX_ROOM_TYPE_ID_REQUIRED"
  );
  const timezone = assertValidTimezone(input.propertyTimezone);
  const dateKeys = normalizeDateKeys(input.dateKeys ?? []);

  if (dateKeys.length === 0) {
    throw new Error("CHANNEX_ARI_AVAILABILITY_DATE_KEYS_REQUIRED");
  }

  if (dateKeys.length > CHANNEX_ARI_FULL_SYNC_DAYS) {
    throw new Error("CHANNEX_ARI_AVAILABILITY_DATE_KEYS_EXCEED_HORIZON");
  }

  const dateFrom = dateKeys[0];
  const dateToExclusive = addUtcDays(dateKeys[dateKeys.length - 1], 1);

  if (
    Math.round(
      (new Date(`${dateToExclusive}T00:00:00.000Z`).getTime() -
        new Date(`${dateFrom}T00:00:00.000Z`).getTime()) /
        (24 * 60 * 60 * 1000)
    ) > CHANNEX_ARI_FULL_SYNC_DAYS
  ) {
    throw new Error("CHANNEX_ARI_AVAILABILITY_SCOPE_EXCEEDS_HORIZON");
  }

  const activeReservationRanges = normalizeRanges(
    input.activeReservationRanges ?? [],
    "RESERVATION"
  );
  const blockedRanges = normalizeRanges(input.blockedRanges ?? [], "BLOCK");
  const occupiedRanges = [...activeReservationRanges, ...blockedRanges];
  const unavailableDateKeys: string[] = [];

  const values: ChannexAriAvailabilityValue[] = dateKeys.map((dateKey) => {
    const night = buildLocalNightInterval(dateKey, timezone);
    const unavailable = occupiedRanges.some((range) => overlaps(night, range));

    if (unavailable) {
      unavailableDateKeys.push(dateKey);
    }

    return {
      property_id: channexPropertyId,
      room_type_id: channexRoomTypeId,
      date: dateKey,
      availability: unavailable ? 0 : 1,
    };
  });

  const payload: ChannexAriAvailabilityPayload = { values };
  const serialized = canonicalJson(payload);
  const payloadBytes = assertPayloadWithinLimit(payload);
  const payloadHash = crypto
    .createHash("sha256")
    .update(serialized)
    .digest("hex");

  return {
    payload,
    payloadHash,
    payloadBytes,
    payloadValueCount: values.length,
    dateFrom,
    dateToExclusive,
    unavailableDateKeys,
  };
}
