import crypto from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";

import {
  CHANNEX_ARI_FULL_SYNC_DAYS,
  addUtcDays,
  assertDateKey,
  assertPayloadWithinLimit,
  countRangeDays,
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

type AvailabilityRangeSource = "RESERVATION" | "BLOCK";

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
  source: AvailabilityRangeSource
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

function toPropertyDateKey(date: Date, timezone: string): string {
  return assertDateKey(formatInTimeZone(date, timezone, "yyyy-MM-dd"));
}

function addDateRangeToSet(input: {
  target: Set<string>;
  from: string;
  toExclusive: string;
  errorCode: string;
}): void {
  if (input.toExclusive <= input.from) {
    throw new Error(input.errorCode);
  }

  for (
    let dateKey = input.from;
    dateKey < input.toExclusive;
    dateKey = addUtcDays(dateKey, 1)
  ) {
    input.target.add(dateKey);
  }
}

function buildOccupiedDateKeySet(input: {
  ranges: ChannexAriAvailabilityRange[];
  source: AvailabilityRangeSource;
  timezone: string;
}): Set<string> {
  const occupiedDateKeys = new Set<string>();
  const normalizedRanges = normalizeRanges(input.ranges, input.source);

  normalizedRanges.forEach((range, index) => {
    const from = toPropertyDateKey(range.startsAt, input.timezone);
    let toExclusive = toPropertyDateKey(range.endsAt, input.timezone);

    if (input.source === "BLOCK" && toExclusive <= from) {
      toExclusive = addUtcDays(from, 1);
    }

    addDateRangeToSet({
      target: occupiedDateKeys,
      from,
      toExclusive,
      errorCode: `CHANNEX_ARI_${input.source}_${index}_LOCAL_RANGE_INVALID`,
    });
  });

  return occupiedDateKeys;
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
    countRangeDays({
      from: dateFrom,
      toExclusive: dateToExclusive,
    }) > CHANNEX_ARI_FULL_SYNC_DAYS
  ) {
    throw new Error("CHANNEX_ARI_AVAILABILITY_SCOPE_EXCEEDS_HORIZON");
  }

  const reservationDateKeys = buildOccupiedDateKeySet({
    ranges: input.activeReservationRanges ?? [],
    source: "RESERVATION",
    timezone,
  });
  const blockedDateKeys = buildOccupiedDateKeySet({
    ranges: input.blockedRanges ?? [],
    source: "BLOCK",
    timezone,
  });
  const unavailableSet = new Set<string>([
    ...reservationDateKeys,
    ...blockedDateKeys,
  ]);
  const unavailableDateKeys: string[] = [];

  const values: ChannexAriAvailabilityValue[] = dateKeys.map((dateKey) => {
    const unavailable = unavailableSet.has(dateKey);

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
