import { formatInTimeZone } from "date-fns-tz";

import {
  CHANNEX_ARI_FULL_SYNC_DAYS,
  addUtcDays,
  assertDateKey,
  normalizeDateKeys,
} from "./channex-ari-lifecycle.policy";

export type ChannexAriReservationStatus = "ACTIVE" | "CANCELLED";

export type ChannexAriReservationAvailabilitySnapshot = {
  checkIn: Date;
  checkOut: Date;
  status: ChannexAriReservationStatus;
};

export type ChannexAriReservationIntent = {
  messageKind: "AVAILABILITY";
  trigger:
    | "RESERVATION_CREATED"
    | "RESERVATION_CANCELLED"
    | "RESERVATION_REACTIVATED"
    | "RESERVATION_DATES_CHANGED";
  dateKeys: string[];
};

function assertValidTimezone(timezone: string): string {
  const normalized = String(timezone ?? "").trim();

  if (!normalized) {
    throw new Error("CHANNEX_ARI_PROPERTY_TIMEZONE_REQUIRED");
  }

  try {
    formatInTimeZone(new Date("2026-01-01T00:00:00.000Z"), normalized, "yyyy-MM-dd");
  } catch {
    throw new Error("CHANNEX_ARI_PROPERTY_TIMEZONE_INVALID");
  }

  return normalized;
}

function assertValidSnapshot(
  snapshot: ChannexAriReservationAvailabilitySnapshot,
  label: "CURRENT" | "PREVIOUS"
): ChannexAriReservationAvailabilitySnapshot {
  const checkIn = new Date(snapshot.checkIn);
  const checkOut = new Date(snapshot.checkOut);

  if (Number.isNaN(checkIn.getTime())) {
    throw new Error(`CHANNEX_ARI_${label}_CHECK_IN_INVALID`);
  }

  if (Number.isNaN(checkOut.getTime())) {
    throw new Error(`CHANNEX_ARI_${label}_CHECK_OUT_INVALID`);
  }

  if (checkOut <= checkIn) {
    throw new Error(`CHANNEX_ARI_${label}_STAY_RANGE_INVALID`);
  }

  if (snapshot.status !== "ACTIVE" && snapshot.status !== "CANCELLED") {
    throw new Error(`CHANNEX_ARI_${label}_STATUS_INVALID`);
  }

  return {
    checkIn,
    checkOut,
    status: snapshot.status,
  };
}

function toPropertyDateKey(date: Date, timezone: string): string {
  return assertDateKey(formatInTimeZone(date, timezone, "yyyy-MM-dd"));
}

function buildActiveStayDateKeys(input: {
  snapshot: ChannexAriReservationAvailabilitySnapshot;
  timezone: string;
  horizonFrom: string;
  horizonToExclusive: string;
}): string[] {
  if (input.snapshot.status !== "ACTIVE") {
    return [];
  }

  const stayFrom = toPropertyDateKey(input.snapshot.checkIn, input.timezone);
  const stayToExclusive = toPropertyDateKey(
    input.snapshot.checkOut,
    input.timezone
  );

  if (stayToExclusive <= stayFrom) {
    throw new Error("CHANNEX_ARI_RESERVATION_LOCAL_STAY_RANGE_INVALID");
  }

  const activeFrom =
    stayFrom < input.horizonFrom ? input.horizonFrom : stayFrom;
  const activeToExclusive =
    stayToExclusive > input.horizonToExclusive
      ? input.horizonToExclusive
      : stayToExclusive;

  if (activeToExclusive <= activeFrom) {
    return [];
  }

  const dateKeys: string[] = [];

  for (
    let dateKey = activeFrom;
    dateKey < activeToExclusive;
    dateKey = addUtcDays(dateKey, 1)
  ) {
    dateKeys.push(dateKey);
  }

  return dateKeys;
}

function sameDateKeys(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((dateKey, index) => dateKey === right[index])
  );
}

function resolveTrigger(input: {
  previous: ChannexAriReservationAvailabilitySnapshot | null;
  current: ChannexAriReservationAvailabilitySnapshot;
}): ChannexAriReservationIntent["trigger"] {
  if (!input.previous) {
    return "RESERVATION_CREATED";
  }

  if (
    input.previous.status === "ACTIVE" &&
    input.current.status === "CANCELLED"
  ) {
    return "RESERVATION_CANCELLED";
  }

  if (
    input.previous.status === "CANCELLED" &&
    input.current.status === "ACTIVE"
  ) {
    return "RESERVATION_REACTIVATED";
  }

  return "RESERVATION_DATES_CHANGED";
}

export function buildChannexAriReservationIntent(input: {
  previous?: ChannexAriReservationAvailabilitySnapshot | null;
  current: ChannexAriReservationAvailabilitySnapshot;
  propertyTimezone: string;
  todayDateKey: string;
}): ChannexAriReservationIntent | null {
  const timezone = assertValidTimezone(input.propertyTimezone);
  const horizonFrom = assertDateKey(input.todayDateKey, "today");
  const horizonToExclusive = addUtcDays(
    horizonFrom,
    CHANNEX_ARI_FULL_SYNC_DAYS
  );
  const current = assertValidSnapshot(input.current, "CURRENT");
  const previous = input.previous
    ? assertValidSnapshot(input.previous, "PREVIOUS")
    : null;

  const previousDateKeys = previous
    ? buildActiveStayDateKeys({
        snapshot: previous,
        timezone,
        horizonFrom,
        horizonToExclusive,
      })
    : [];
  const currentDateKeys = buildActiveStayDateKeys({
    snapshot: current,
    timezone,
    horizonFrom,
    horizonToExclusive,
  });

  if (sameDateKeys(previousDateKeys, currentDateKeys)) {
    return null;
  }

  const dateKeys = normalizeDateKeys([
    ...previousDateKeys,
    ...currentDateKeys,
  ]);

  if (dateKeys.length === 0) {
    return null;
  }

  return {
    messageKind: "AVAILABILITY",
    trigger: resolveTrigger({ previous, current }),
    dateKeys,
  };
}
