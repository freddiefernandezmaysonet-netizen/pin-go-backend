import {
  calculateChannexAriCanonicalJsonIntegrity,
  stringifyChannexAriCanonicalJson,
} from "./channex-ari-canonical-json.policy";

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

export type ChannexAriRatesRestrictionsChangedField =
  | "rate"
  | "minStayArrival"
  | "minStayThrough"
  | "maxStay";

type ChannexAriRatesRestrictionsFields = {
  property_id: string;
  rate_plan_id: string;
  rate?: ChannexAriRate;
  min_stay_arrival?: number;
  min_stay_through?: number;
  max_stay?: number;
};

export type ChannexAriRatesRestrictionsValue =
  ChannexAriRatesRestrictionsFields &
    (
      | { date: string; date_from?: never; date_to?: never }
      | { date?: never; date_from: string; date_to: string }
    );

type NormalizedChannexAriRatesRestrictionsValue = Omit<
  ChannexAriRatesRestrictionsFields,
  "property_id" | "rate_plan_id"
> & { date: string };

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

const ALL_CHANGED_FIELDS: ChannexAriRatesRestrictionsChangedField[] = [
  "rate",
  "minStayArrival",
  "minStayThrough",
  "maxStay",
];

function normalizeChangedFields(
  changedFields: ChannexAriRatesRestrictionsChangedField[] | undefined
): ChannexAriRatesRestrictionsChangedField[] {
  if (changedFields === undefined) return [...ALL_CHANGED_FIELDS];

  if (!Array.isArray(changedFields) || changedFields.length === 0) {
    throw new Error("CHANNEX_ARI_CHANGED_FIELDS_REQUIRED");
  }

  const normalized = Array.from(new Set(changedFields));

  if (
    normalized.length !== changedFields.length ||
    normalized.some((field) => !ALL_CHANGED_FIELDS.includes(field))
  ) {
    throw new Error("CHANNEX_ARI_CHANGED_FIELDS_INVALID");
  }

  return ALL_CHANGED_FIELDS.filter((field) => normalized.includes(field));
}


function sameCanonicalValue(
  left: NormalizedChannexAriRatesRestrictionsValue,
  right: NormalizedChannexAriRatesRestrictionsValue
): boolean {
  return (
    stringifyChannexAriCanonicalJson(left) ===
    stringifyChannexAriCanonicalJson(right)
  );
}

function sameChangedFields(
  left: NormalizedChannexAriRatesRestrictionsValue,
  right: NormalizedChannexAriRatesRestrictionsValue
): boolean {
  const { date: _leftDate, ...leftFields } = left;
  const { date: _rightDate, ...rightFields } = right;

  return (
    stringifyChannexAriCanonicalJson(leftFields) ===
    stringifyChannexAriCanonicalJson(rightFields)
  );
}

export function buildChannexAriRatesRestrictionsSnapshot(input: {
  channexPropertyId: string;
  channexRatePlanId: string;
  changedFields?: ChannexAriRatesRestrictionsChangedField[];
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

  const changedFields = normalizeChangedFields(input.changedFields);

  const normalizedByDate = new Map<
    string,
    NormalizedChannexAriRatesRestrictionsValue
  >();

  input.values.forEach((sourceValue, index) => {
    const date = assertDateKey(sourceValue.date, `value_${index}`);
    const includesRate = changedFields.includes("rate");
    const includesMinStayArrival = changedFields.includes("minStayArrival");
    const includesMinStayThrough = changedFields.includes("minStayThrough");
    const includesMaxStay = changedFields.includes("maxStay");
    const rate = includesRate
      ? assertValidRate(sourceValue.rate, index)
      : undefined;
    const minStayArrival = includesMinStayArrival
      ? assertPositiveInteger(
          sourceValue.minStayArrival,
          "MIN_STAY_ARRIVAL",
          index
        )
      : undefined;
    const minStayThrough = includesMinStayThrough
      ? assertPositiveInteger(
          sourceValue.minStayThrough,
          "MIN_STAY_THROUGH",
          index
        )
      : undefined;
    const maxStay = includesMaxStay
      ? assertNonNegativeInteger(sourceValue.maxStay, index)
      : undefined;

    if (
      maxStay !== undefined &&
      maxStay > 0 &&
      ((minStayArrival !== undefined && maxStay < minStayArrival) ||
        (minStayThrough !== undefined && maxStay < minStayThrough))
    ) {
      throw new Error(`CHANNEX_ARI_MAX_STAY_${index}_BELOW_MINIMUM`);
    }

    const normalizedValue = {
      date,
      ...(rate !== undefined ? { rate } : {}),
      ...(minStayArrival !== undefined
        ? { min_stay_arrival: minStayArrival }
        : {}),
      ...(minStayThrough !== undefined
        ? { min_stay_through: minStayThrough }
        : {}),
      ...(maxStay !== undefined ? { max_stay: maxStay } : {}),
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

  const values: ChannexAriRatesRestrictionsValue[] = [];

  for (let index = 0; index < normalizedValues.length; ) {
    const first = normalizedValues[index];
    let lastIndex = index;

    while (
      lastIndex + 1 < normalizedValues.length &&
      normalizedValues[lastIndex + 1].date ===
        addUtcDays(normalizedValues[lastIndex].date, 1) &&
      sameChangedFields(first, normalizedValues[lastIndex + 1])
    ) {
      lastIndex += 1;
    }

    const { date, ...changedValues } = first;
    const identity = {
      property_id: channexPropertyId,
      rate_plan_id: channexRatePlanId,
    };

    values.push(
      lastIndex === index
        ? { ...identity, date, ...changedValues }
        : {
            ...identity,
            date_from: date,
            date_to: normalizedValues[lastIndex].date,
            ...changedValues,
          }
    );
    index = lastIndex + 1;
  }
  const payload: ChannexAriRatesRestrictionsPayload = { values };
  const integrity =
    calculateChannexAriCanonicalJsonIntegrity(payload);
  const payloadBytes = assertPayloadWithinLimit(payload);

  if (payloadBytes !== integrity.payloadBytes) {
    throw new Error(
      "CHANNEX_ARI_RATES_RESTRICTIONS_PAYLOAD_BYTES_MISMATCH"
    );
  }

  const payloadHash = integrity.payloadHash;

  return {
    payload,
    payloadHash,
    payloadBytes,
    payloadValueCount: values.length,
    dateFrom,
    dateToExclusive,
  };
}
