export const CHANNEX_ARI_FULL_SYNC_DAYS = 500;
export const CHANNEX_ARI_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
export const CHANNEX_ARI_MIN_SAME_KIND_SPACING_MS = 6_500;
export const CHANNEX_ARI_MIN_RATE_LIMIT_PAUSE_MS = 60_000;
export const CHANNEX_ARI_DEFAULT_COALESCE_MS = 30_000;
export const CHANNEX_ARI_MAX_COALESCE_MS = 60_000;
export const CHANNEX_ARI_MAX_ATTEMPTS = 8;

export type ChannexAriMessageKind =
  | "AVAILABILITY"
  | "RATES_RESTRICTIONS";

export type ChannexAriSyncMode = "INCREMENTAL" | "FULL";

export type ChannexAriRetryClass =
  | "SUCCESS"
  | "RETRYABLE"
  | "TERMINAL";

export type ChannexAriDateRange = {
  from: string;
  toExclusive: string;
};

export type ChannexAriResponseEvidence = {
  httpStatus: number | null;
  taskId: string | null;
  warningCount: number;
};

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function assertDateKey(value: string, fieldName = "date"): string {
  const normalized = String(value ?? "").trim();

  if (!DATE_KEY_PATTERN.test(normalized)) {
    throw new Error(`CHANNEX_ARI_INVALID_${fieldName.toUpperCase()}`);
  }

  const parsed = new Date(`${normalized}T00:00:00.000Z`);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
  ) {
    throw new Error(`CHANNEX_ARI_INVALID_${fieldName.toUpperCase()}`);
  }

  return normalized;
}

export function addUtcDays(dateKey: string, days: number): string {
  const normalized = assertDateKey(dateKey);

  if (!Number.isInteger(days)) {
    throw new Error("CHANNEX_ARI_INVALID_DAY_OFFSET");
  }

  const date = new Date(`${normalized}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function buildFullSyncRange(todayDateKey: string): ChannexAriDateRange {
  const from = assertDateKey(todayDateKey, "from");

  return {
    from,
    toExclusive: addUtcDays(from, CHANNEX_ARI_FULL_SYNC_DAYS),
  };
}

export function countRangeDays(range: ChannexAriDateRange): number {
  const from = new Date(`${assertDateKey(range.from, "from")}T00:00:00.000Z`);
  const toExclusive = new Date(
    `${assertDateKey(range.toExclusive, "to_exclusive")}T00:00:00.000Z`
  );

  const days = Math.round(
    (toExclusive.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)
  );

  if (days <= 0) {
    throw new Error("CHANNEX_ARI_INVALID_DATE_RANGE");
  }

  return days;
}

export function normalizeDateKeys(dateKeys: string[]): string[] {
  return Array.from(
    new Set(dateKeys.map((dateKey) => assertDateKey(dateKey)))
  ).sort();
}

export function mergeDateRanges(
  ranges: ChannexAriDateRange[]
): ChannexAriDateRange[] {
  if (ranges.length === 0) return [];

  const normalized = ranges
    .map((range) => ({
      from: assertDateKey(range.from, "from"),
      toExclusive: assertDateKey(range.toExclusive, "to_exclusive"),
    }))
    .map((range) => {
      countRangeDays(range);
      return range;
    })
    .sort((a, b) => a.from.localeCompare(b.from));

  const merged: ChannexAriDateRange[] = [];

  for (const range of normalized) {
    const previous = merged[merged.length - 1];

    if (!previous) {
      merged.push({ ...range });
      continue;
    }

    if (range.from <= previous.toExclusive) {
      if (range.toExclusive > previous.toExclusive) {
        previous.toExclusive = range.toExclusive;
      }
      continue;
    }

    merged.push({ ...range });
  }

  return merged;
}

export function classifyChannexAriAttempt(input: {
  httpStatus?: number | null;
  networkError?: boolean;
  timedOut?: boolean;
  taskId?: string | null;
  warningCount?: number | null;
}): ChannexAriRetryClass {
  if (input.networkError || input.timedOut) {
    return "RETRYABLE";
  }

  const status = Number(input.httpStatus ?? 0);
  const taskId = String(input.taskId ?? "").trim();
  const warningCount = Math.max(0, Number(input.warningCount ?? 0));

  if (status === 429 || status >= 500) {
    return "RETRYABLE";
  }

  if (status >= 200 && status < 300) {
    if (!taskId || warningCount > 0) {
      return "TERMINAL";
    }

    return "SUCCESS";
  }

  return "TERMINAL";
}

export function getRetryDelayMs(input: {
  attemptNumber: number;
  retryAfterMs?: number | null;
  jitterMs?: number;
}): number {
  if (!Number.isInteger(input.attemptNumber) || input.attemptNumber < 1) {
    throw new Error("CHANNEX_ARI_INVALID_ATTEMPT_NUMBER");
  }

  const retryAfterMs = Number(input.retryAfterMs ?? 0);
  const boundedJitterMs = Math.max(0, Math.min(5_000, input.jitterMs ?? 0));
  const exponentialMs = Math.min(
    60 * 60 * 1000,
    CHANNEX_ARI_MIN_RATE_LIMIT_PAUSE_MS * 2 ** (input.attemptNumber - 1)
  );

  return (
    Math.max(
      CHANNEX_ARI_MIN_RATE_LIMIT_PAUSE_MS,
      Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
      exponentialMs
    ) + boundedJitterMs
  );
}

export function assertPayloadWithinLimit(payload: unknown): number {
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");

  if (payloadBytes <= 0) {
    throw new Error("CHANNEX_ARI_EMPTY_PAYLOAD");
  }

  if (payloadBytes > CHANNEX_ARI_MAX_REQUEST_BYTES) {
    throw new Error("CHANNEX_ARI_PAYLOAD_TOO_LARGE");
  }

  return payloadBytes;
}

export function isFullSyncGuardActive(input: {
  now: Date;
  lastFullSyncRequestedAt?: Date | null;
  guardMs?: number;
}): boolean {
  if (!input.lastFullSyncRequestedAt) return false;

  const guardMs = Math.max(
    0,
    input.guardMs ?? 24 * 60 * 60 * 1000
  );

  return (
    input.now.getTime() - input.lastFullSyncRequestedAt.getTime() < guardMs
  );
}

export function validateV1Mapping(input: {
  connectionProvider: string;
  connectionOrganizationId: string;
  propertyOrganizationId: string;
  propertyId: string | null;
  externalRoomTypeId: string | null;
  channexPropertyId: string | null;
  channexRatePlanId: string | null;
}): { ok: true } | { ok: false; reason: string } {
  if (input.connectionProvider !== "CHANNEX") {
    return { ok: false, reason: "CHANNEX_ARI_PROVIDER_MISMATCH" };
  }

  if (input.connectionOrganizationId !== input.propertyOrganizationId) {
    return { ok: false, reason: "CHANNEX_ARI_TENANT_MISMATCH" };
  }

  if (!String(input.propertyId ?? "").trim()) {
    return { ok: false, reason: "CHANNEX_ARI_PROPERTY_MAPPING_MISSING" };
  }

  if (!String(input.externalRoomTypeId ?? "").trim()) {
    return { ok: false, reason: "CHANNEX_ARI_ROOM_TYPE_MAPPING_MISSING" };
  }

  if (!String(input.channexPropertyId ?? "").trim()) {
    return { ok: false, reason: "CHANNEX_ARI_CHANNEX_PROPERTY_MAPPING_MISSING" };
  }

  if (!String(input.channexRatePlanId ?? "").trim()) {
    return { ok: false, reason: "CHANNEX_ARI_RATE_PLAN_MAPPING_MISSING" };
  }

  return { ok: true };
}
