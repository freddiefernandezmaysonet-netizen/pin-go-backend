import type { Prisma } from "@prisma/client";
import {
  CHANNEX_ARI_DEFAULT_COALESCE_MS,
  CHANNEX_ARI_FULL_SYNC_DAYS,
  CHANNEX_ARI_MAX_COALESCE_MS,
  addUtcDays,
  assertDateKey,
  buildFullSyncRange,
  countRangeDays,
  normalizeDateKeys,
  type ChannexAriDateRange,
  type ChannexAriMessageKind,
  type ChannexAriSyncMode,
} from "./channex-ari-lifecycle.policy";

type ChannexAriOutboxDb = Pick<
  Prisma.TransactionClient,
  "distributionOutboxEvent"
>;

type ChannexAriOutboxSource = {
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
};

type ChannexAriOutboxBaseInput = ChannexAriOutboxSource & {
  organizationId: string;
  propertyId: string;
  messageKind: ChannexAriMessageKind;
  trigger: string;
  correlationId?: string | null;
  now?: Date;
  coalesceMs?: number;
};

export type CreateIncrementalChannexAriOutboxEventInput =
  ChannexAriOutboxBaseInput & {
    syncMode?: "INCREMENTAL";
    dateKeys?: string[];
    dateRange?: ChannexAriDateRange;
    todayDateKey?: never;
  };

export type CreateFullChannexAriOutboxEventInput =
  ChannexAriOutboxBaseInput & {
    syncMode: "FULL";
    todayDateKey: string;
    dateKeys?: never;
    dateRange?: never;
    coalesceMs?: 0;
  };

export type CreateChannexAriOutboxEventInput =
  | CreateIncrementalChannexAriOutboxEventInput
  | CreateFullChannexAriOutboxEventInput;

type NormalizedOutboxScope = {
  syncMode: ChannexAriSyncMode;
  scope: "EXACT_DATES" | "DATE_RANGE" | "FULL_HORIZON";
  dateFrom: string;
  dateToExclusive: string;
  dateKeys: string[];
};

function requireText(value: unknown, errorCode: string): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(errorCode);
  }

  return normalized;
}

function normalizeOptionalText(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function assertValidNow(value?: Date): Date {
  const now = value ? new Date(value) : new Date();

  if (Number.isNaN(now.getTime())) {
    throw new Error("CHANNEX_ARI_INVALID_NOW");
  }

  return now;
}

function toDatabaseDate(dateKey: string): Date {
  return new Date(`${assertDateKey(dateKey)}T00:00:00.000Z`);
}

function assertWithinActiveHorizon(range: ChannexAriDateRange): void {
  const rangeDays = countRangeDays(range);

  if (rangeDays > CHANNEX_ARI_FULL_SYNC_DAYS) {
    throw new Error("CHANNEX_ARI_RANGE_EXCEEDS_HORIZON");
  }
}

function normalizeIncrementalScope(
  input: CreateIncrementalChannexAriOutboxEventInput
): NormalizedOutboxScope {
  const hasDateKeys = Array.isArray(input.dateKeys) && input.dateKeys.length > 0;
  const hasDateRange = Boolean(input.dateRange);

  if (hasDateKeys === hasDateRange) {
    throw new Error("CHANNEX_ARI_INCREMENTAL_SCOPE_REQUIRED");
  }

  if (hasDateKeys) {
    const dateKeys = normalizeDateKeys(input.dateKeys ?? []);

    if (dateKeys.length > CHANNEX_ARI_FULL_SYNC_DAYS) {
      throw new Error("CHANNEX_ARI_DATE_KEYS_EXCEED_HORIZON");
    }

    const dateFrom = dateKeys[0];
    const dateToExclusive = addUtcDays(dateKeys[dateKeys.length - 1], 1);

    assertWithinActiveHorizon({
      from: dateFrom,
      toExclusive: dateToExclusive,
    });

    return {
      syncMode: "INCREMENTAL",
      scope: "EXACT_DATES",
      dateFrom,
      dateToExclusive,
      dateKeys,
    };
  }

  const dateRange = {
    from: assertDateKey(input.dateRange!.from, "from"),
    toExclusive: assertDateKey(
      input.dateRange!.toExclusive,
      "to_exclusive"
    ),
  };

  assertWithinActiveHorizon(dateRange);

  return {
    syncMode: "INCREMENTAL",
    scope: "DATE_RANGE",
    dateFrom: dateRange.from,
    dateToExclusive: dateRange.toExclusive,
    dateKeys: [],
  };
}

function normalizeFullScope(
  input: CreateFullChannexAriOutboxEventInput
): NormalizedOutboxScope {
  const range = buildFullSyncRange(input.todayDateKey);

  if (countRangeDays(range) !== CHANNEX_ARI_FULL_SYNC_DAYS) {
    throw new Error("CHANNEX_ARI_FULL_SYNC_RANGE_INVALID");
  }

  return {
    syncMode: "FULL",
    scope: "FULL_HORIZON",
    dateFrom: range.from,
    dateToExclusive: range.toExclusive,
    dateKeys: [],
  };
}

function normalizeScope(
  input: CreateChannexAriOutboxEventInput
): NormalizedOutboxScope {
  return input.syncMode === "FULL"
    ? normalizeFullScope(input)
    : normalizeIncrementalScope(input);
}

function resolveAvailableAt(input: {
  now: Date;
  syncMode: ChannexAriSyncMode;
  coalesceMs?: number;
}): Date {
  if (input.syncMode === "FULL") {
    if (input.coalesceMs !== undefined && input.coalesceMs !== 0) {
      throw new Error("CHANNEX_ARI_FULL_SYNC_CANNOT_COALESCE");
    }

    return input.now;
  }

  const coalesceMs =
    input.coalesceMs === undefined
      ? CHANNEX_ARI_DEFAULT_COALESCE_MS
      : Number(input.coalesceMs);

  if (
    !Number.isInteger(coalesceMs) ||
    coalesceMs < 0 ||
    coalesceMs > CHANNEX_ARI_MAX_COALESCE_MS
  ) {
    throw new Error("CHANNEX_ARI_INVALID_COALESCE_MS");
  }

  return new Date(input.now.getTime() + coalesceMs);
}

function validateMessageKind(
  value: ChannexAriMessageKind
): ChannexAriMessageKind {
  if (value !== "AVAILABILITY" && value !== "RATES_RESTRICTIONS") {
    throw new Error("CHANNEX_ARI_INVALID_MESSAGE_KIND");
  }

  return value;
}

export async function createChannexAriOutboxEvent(
  db: ChannexAriOutboxDb,
  input: CreateChannexAriOutboxEventInput
) {
  const organizationId = requireText(
    input.organizationId,
    "CHANNEX_ARI_ORGANIZATION_ID_REQUIRED"
  );
  const propertyId = requireText(
    input.propertyId,
    "CHANNEX_ARI_PROPERTY_ID_REQUIRED"
  );
  const trigger = requireText(input.trigger, "CHANNEX_ARI_TRIGGER_REQUIRED");
  const messageKind = validateMessageKind(input.messageKind);
  const sourceEntityType = normalizeOptionalText(input.sourceEntityType);
  const sourceEntityId = normalizeOptionalText(input.sourceEntityId);
  const correlationId = normalizeOptionalText(input.correlationId);
  const now = assertValidNow(input.now);
  const normalizedScope = normalizeScope(input);
  const availableAt = resolveAvailableAt({
    now,
    syncMode: normalizedScope.syncMode,
    coalesceMs: input.coalesceMs,
  });

  if (Boolean(sourceEntityType) !== Boolean(sourceEntityId)) {
    throw new Error("CHANNEX_ARI_SOURCE_IDENTITY_INCOMPLETE");
  }

  if (normalizedScope.syncMode === "FULL" && !correlationId) {
    throw new Error("CHANNEX_ARI_FULL_SYNC_CORRELATION_ID_REQUIRED");
  }

  return db.distributionOutboxEvent.create({
    data: {
      organizationId,
      propertyId,
      provider: "CHANNEX",
      messageKind,
      syncMode: normalizedScope.syncMode,
      scope: normalizedScope.scope,
      dateFrom: toDatabaseDate(normalizedScope.dateFrom),
      dateToExclusive: toDatabaseDate(normalizedScope.dateToExclusive),
      dateKeys: normalizedScope.dateKeys,
      trigger,
      sourceEntityType,
      sourceEntityId,
      correlationId,
      status: "PENDING",
      availableAt,
    },
  });
}
