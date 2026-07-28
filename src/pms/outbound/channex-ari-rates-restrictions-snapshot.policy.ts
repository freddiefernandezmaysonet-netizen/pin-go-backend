import crypto from "node:crypto";

import {
  CHANNEX_ARI_FULL_SYNC_DAYS,
  addUtcDays,
  assertDateKey,
  assertPayloadWithinLimit,
  countRangeDays,
} from "./channex-ari-lifecycle.policy";

export type ChannexAriRate = string | number;

export type ChannexAriRatesRestrictionsSourceValue = {
  date: string;
  rate: ChannexAriRate;
  minStayArrival: number;
  minStayThrough: number;
  maxStay: number;
};

export type ChannexAriRatesRestrictionsValue = {
  property_id: string;
  rate_plan_id: string;
  date: string;
  rate: ChannexAriRate;
  min_stay_arrival: number;
  min_stay_through: number;
  max_stay: number;
};

export type ChannexAriRatesRestrictionsPayload = {
  values: ChannexAriRatesRestrictionsValue[];
};

export type ChannexAriRatesRestrictionsSnapshot = {
  payload: ChannexAriRatesRestrictionsPayload;
  payloadHash: string;
  payloadBytes: number;
  payloadValueCount: number;
  dateFrom: string;
  dateToExclusive: string;
};

function requireText(value: unknown, errorCode: string): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(errorCode);
  }

  return normalized;
}

function assertPositiveDecimalString(value: string, index: number): string {
  if (value !== value.trim() || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`CHANNEX_ARI_RATE_${index}_INVALID`);
  }

  if (!/[1-9]/.test(value)) {
    throw new Error(`CHANNEX_ARI_RATE_${index}_NOT_POSITIVE`);
  }

  return value;
}

function assertValidRate(value: ChannexAriRate, index: number): ChannexAriRate {
  if (typeof value === "string") {
    return assertPositiveDecimalString(value, index);
  }

  if (!Number.isSafeInteger(value)) {
    throw new Error(`CHANNEX_ARI_RATE_${index}_INVALID`);
  }

  if (value <= 0) {
    throw new Error(`CHANNEX_ARI_RATE_${index}_NOT_POSITIVE`);
  }

  return value;
}

function assertPositiveInteger(
  value: number,
  field: "MIN_STAY_ARRIVAL" | "MIN_STAY_THROUGH",
  index: number
): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`CHANNEX_ARI_${field}_${index}_INVALID`);
  }

  return value;
}

function assertNonNegativeInteger(value: number, index: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`CHANNEX_ARI_MAX_STAY_${index}_INVALID`);
  }

  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function sameCanonicalValue(
  left: Omit<ChannexAriRatesRestrictionsValue, "property_id" | "rate_plan_id">,
  right: Omit<ChannexAriRatesRestrictionsValue, "property_id" | "rate_plan_id">
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function buildChannexAriRatesRestrictionsSnapshot(input: {
  channexPropertyId: string;
  channexRatePlanId: string;
  values: ChannexAriRatesRestrictionsSourceValue[];
}): ChannexAriRatesRestrictionsSnapshot {
  const channexPropertyId = requireText(
    input.channexPropertyId,
    "CHANNEX_ARI_CHANNEX_PROPERTY_ID_REQUIRED"
  );
  const channexRatePlanId = requireText(
    input.channexRatePlanId,
    "CHANNEX_ARI_CHANNEX_RATE_PLAN_ID_REQUIRED"
  );

  if (!Array.isArray(input.values) || input.values.length === 0) {
    throw new Error("CHANNEX_ARI_RATES_RESTRICTIONS_VALUES_REQUIRED");
  }

  const normalizedByDate = new Map<
    string,
    Omit<ChannexAriRatesRestrictionsValue, "property_id" | "rate_plan_id">
  >();

  input.values.forEach((sourceValue, index) => {
    const date = assertDateKey(sourceValue.date, `value_${index}`);
    const rate = assertValidRate(sourceValue.rate, index);
    const minStayArrival = assertPositiveInteger(
      sourceValue.minStayArrival,
      "MIN_STAY_ARRIVAL",
      index
    );
    const minStayThrough = assertPositiveInteger(
      sourceValue.minStayThrough,
      "MIN_STAY_THROUGH",
      index
    );
    const maxStay = assertNonNegativeInteger(sourceValue.maxStay, index);

    if (
      maxStay > 0 &&
      (maxStay < minStayArrival || maxStay < minStayThrough)
    ) {
      throw new Error(`CHANNEX_ARI_MAX_STAY_${index}_BELOW_MINIMUM`);
    }

    const normalizedValue = {
      date,
      rate,
      min_stay_arrival: minStayArrival,
      min_stay_through: minStayThrough,
      max_stay: maxStay,
    };
    const existing = normalizedByDate.get(date);

    if (existing && !sameCanonicalValue(existing, normalizedValue)) {
      throw new Error(`CHANNEX_ARI_DUPLICATE_DATE_CONFLICT:${date}`);
    }

    normalizedByDate.set(date, normalizedValue);
  });

  const normalizedValues = Array.from(normalizedByDate.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  if (normalizedValues.length > CHANNEX_ARI_FULL_SYNC_DAYS) {
    throw new Error("CHANNEX_ARI_RATES_RESTRICTIONS_VALUES_EXCEED_HORIZON");
  }

  const dateFrom = normalizedValues[0].date;
  const dateToExclusive = addUtcDays(
    normalizedValues[normalizedValues.length - 1].date,
    1
  );

  if (
    countRangeDays({
      from: dateFrom,
      toExclusive: dateToExclusive,
    }) > CHANNEX_ARI_FULL_SYNC_DAYS
  ) {
    throw new Error("CHANNEX_ARI_RATES_RESTRICTIONS_SCOPE_EXCEEDS_HORIZON");
  }

  const values: ChannexAriRatesRestrictionsValue[] = normalizedValues.map(
    (value) => ({
      property_id: channexPropertyId,
      rate_plan_id: channexRatePlanId,
      ...value,
    })
  );
  const payload: ChannexAriRatesRestrictionsPayload = { values };
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
  };
}
