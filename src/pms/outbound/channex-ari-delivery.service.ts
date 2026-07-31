import { calculateChannexAriCanonicalJsonIntegrity } from "./channex-ari-canonical-json.policy";
import type { Prisma } from "@prisma/client";

import {
  CHANNEX_ARI_FULL_SYNC_DAYS,
  addUtcDays,
  assertDateKey,
  assertPayloadWithinLimit,
  countRangeDays,
  normalizeDateKeys,
  validateV1Mapping,
  type ChannexAriMessageKind,
} from "./channex-ari-lifecycle.policy";
import type { ChannexAriCoalescingPlan } from "./channex-ari-coalescing.policy";
import type { ChannexAriAvailabilitySnapshot } from "./channex-ari-availability-snapshot.policy";
import type { ChannexAriRatesRestrictionsSnapshot } from "./channex-ari-rates-restrictions-snapshot.policy";

type ChannexAriDeliveryTransaction = Pick<
  Prisma.TransactionClient,
  "distributionOutboxEvent" | "channexAriDelivery"
>;

export type ChannexAriDeliveryDb = {
  $transaction<T>(
    callback: (tx: ChannexAriDeliveryTransaction) => Promise<T>
  ): Promise<T>;
};

export type ChannexAriDeliveryMapping = {
  connectionId: string;
  listingId: string;
  connectionProvider: string;
  connectionOrganizationId: string;
  propertyOrganizationId: string;
  propertyId: string;
  externalRoomTypeId: string;
  channexPropertyId: string;
  channexRatePlanId: string;
};

export type ChannexAriDeliverySnapshot =
  | {
      messageKind: "AVAILABILITY";
      data: ChannexAriAvailabilitySnapshot;
    }
  | {
      messageKind: "RATES_RESTRICTIONS";
      data: ChannexAriRatesRestrictionsSnapshot;
    };

export type CreateChannexAriDeliveryInput = {
  plan: ChannexAriCoalescingPlan;
  mapping: ChannexAriDeliveryMapping;
  snapshot: ChannexAriDeliverySnapshot;
  supersededEventIds?: string[];
  queuedAt?: Date;
};

type NormalizedDeliveryInput = {
  plan: ChannexAriCoalescingPlan;
  mapping: ChannexAriDeliveryMapping;
  snapshot: ChannexAriDeliverySnapshot;
  mergedEventIds: string[];
  supersededEventIds: string[];
  queuedAt: Date;
};

type DeliveryPayloadValue = Record<string, unknown> & {
  property_id: string;
  date: string;
};

type DeliveryPayload = {
  values: DeliveryPayloadValue[];
};

function requireText(value: unknown, errorCode: string): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(errorCode);
  }

  return normalized;
}

function assertValidInstant(value: Date | undefined, errorCode: string): Date {
  const normalized = value ? new Date(value) : new Date();

  if (Number.isNaN(normalized.getTime())) {
    throw new Error(errorCode);
  }

  return normalized;
}

function uniqueRequiredIds(values: string[], errorPrefix: string): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${errorPrefix}_REQUIRED`);
  }

  const normalized = values.map((value) =>
    requireText(value, `${errorPrefix}_INVALID`)
  );
  const unique = Array.from(new Set(normalized));

  if (unique.length !== normalized.length) {
    throw new Error(`${errorPrefix}_DUPLICATE`);
  }

  return unique;
}

function uniqueOptionalIds(values: string[] | undefined, errorPrefix: string): string[] {
  if (!values || values.length === 0) return [];
  return uniqueRequiredIds(values, errorPrefix);
}

function toDatabaseDate(dateKey: string): Date {
  return new Date(`${assertDateKey(dateKey)}T00:00:00.000Z`);
}

function toDateKey(value: unknown, fieldName: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`CHANNEX_ARI_INVALID_${fieldName.toUpperCase()}`);
    }

    return assertDateKey(value.toISOString().slice(0, 10), fieldName);
  }

  return assertDateKey(String(value ?? ""), fieldName);
}

function expandRange(from: string, toExclusive: string): string[] {
  const days = countRangeDays({ from, toExclusive });

  if (days > CHANNEX_ARI_FULL_SYNC_DAYS) {
    throw new Error("CHANNEX_ARI_DELIVERY_SCOPE_EXCEEDS_HORIZON");
  }

  return Array.from({ length: days }, (_, index) => addUtcDays(from, index));
}

function assertSameStringArray(
  actual: string[],
  expected: string[],
  errorCode: string
): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(errorCode);
  }
}

function assertExactObjectKeys(
  value: Record<string, unknown>,
  expectedKeys: string[],
  errorCode: string
): void {
  const actualKeys = Object.keys(value).sort();
  const normalizedExpected = [...expectedKeys].sort();

  if (
    actualKeys.length !== normalizedExpected.length ||
    actualKeys.some((key, index) => key !== normalizedExpected[index])
  ) {
    throw new Error(errorCode);
  }
}

function assertPositiveRate(value: unknown, index: number): void {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`CHANNEX_ARI_DELIVERY_RATE_${index}_INVALID`);
    }

    return;
  }

  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !/^\d+(?:\.\d+)?$/.test(value) ||
    !/[1-9]/.test(value)
  ) {
    throw new Error(`CHANNEX_ARI_DELIVERY_RATE_${index}_INVALID`);
  }
}

function assertPositiveInteger(
  value: unknown,
  fieldName: string,
  index: number
): number {
  const normalized = Number(value);

  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(
      `CHANNEX_ARI_DELIVERY_${fieldName}_${index}_INVALID`
    );
  }

  return normalized;
}

function assertNonNegativeInteger(
  value: unknown,
  fieldName: string,
  index: number
): number {
  const normalized = Number(value);

  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(
      `CHANNEX_ARI_DELIVERY_${fieldName}_${index}_INVALID`
    );
  }

  return normalized;
}

function assertValidPlan(plan: ChannexAriCoalescingPlan): void {
  requireText(plan.organizationId, "CHANNEX_ARI_ORGANIZATION_ID_REQUIRED");
  requireText(plan.propertyId, "CHANNEX_ARI_PROPERTY_ID_REQUIRED");

  if (plan.provider !== "CHANNEX") {
    throw new Error("CHANNEX_ARI_PROVIDER_MISMATCH");
  }

  if (
    plan.messageKind !== "AVAILABILITY" &&
    plan.messageKind !== "RATES_RESTRICTIONS"
  ) {
    throw new Error("CHANNEX_ARI_INVALID_MESSAGE_KIND");
  }

  const dateFrom = assertDateKey(plan.dateFrom, "date_from");
  const dateToExclusive = assertDateKey(
    plan.dateToExclusive,
    "date_to_exclusive"
  );
  const rangeDays = countRangeDays({ from: dateFrom, toExclusive: dateToExclusive });

  if (rangeDays > CHANNEX_ARI_FULL_SYNC_DAYS) {
    throw new Error("CHANNEX_ARI_DELIVERY_SCOPE_EXCEEDS_HORIZON");
  }

  if (plan.syncMode === "FULL") {
    if (plan.scope !== "FULL_HORIZON") {
      throw new Error("CHANNEX_ARI_FULL_SYNC_SCOPE_INVALID");
    }

    if (rangeDays !== CHANNEX_ARI_FULL_SYNC_DAYS) {
      throw new Error("CHANNEX_ARI_FULL_SYNC_RANGE_INVALID");
    }

    if (plan.dateKeys.length > 0) {
      throw new Error("CHANNEX_ARI_FULL_SYNC_DATE_KEYS_NOT_ALLOWED");
    }

    requireText(
      plan.correlationId,
      "CHANNEX_ARI_FULL_SYNC_CORRELATION_ID_REQUIRED"
    );
  } else if (plan.syncMode === "INCREMENTAL") {
    if (plan.scope === "EXACT_DATES") {
      const dateKeys = normalizeDateKeys(plan.dateKeys);

      if (dateKeys.length === 0) {
        throw new Error("CHANNEX_ARI_EXACT_DATE_KEYS_REQUIRED");
      }

      assertSameStringArray(
        dateKeys,
        plan.dateKeys,
        "CHANNEX_ARI_DELIVERY_PLAN_DATE_KEYS_NOT_CANONICAL"
      );

      if (
        dateKeys[0] !== dateFrom ||
        addUtcDays(dateKeys[dateKeys.length - 1], 1) !== dateToExclusive
      ) {
        throw new Error("CHANNEX_ARI_EXACT_DATE_BOUNDS_MISMATCH");
      }
    } else if (plan.scope === "DATE_RANGE") {
      if (plan.dateKeys.length > 0) {
        throw new Error("CHANNEX_ARI_DATE_RANGE_KEYS_NOT_ALLOWED");
      }
    } else {
      throw new Error("CHANNEX_ARI_INCREMENTAL_SCOPE_INVALID");
    }
  } else {
    throw new Error("CHANNEX_ARI_INVALID_SYNC_MODE");
  }
}

function normalizeMapping(
  mapping: ChannexAriDeliveryMapping,
  plan: ChannexAriCoalescingPlan
): ChannexAriDeliveryMapping {
  const normalized = {
    connectionId: requireText(
      mapping.connectionId,
      "CHANNEX_ARI_CONNECTION_ID_REQUIRED"
    ),
    listingId: requireText(mapping.listingId, "CHANNEX_ARI_LISTING_ID_REQUIRED"),
    connectionProvider: requireText(
      mapping.connectionProvider,
      "CHANNEX_ARI_CONNECTION_PROVIDER_REQUIRED"
    ),
    connectionOrganizationId: requireText(
      mapping.connectionOrganizationId,
      "CHANNEX_ARI_CONNECTION_ORGANIZATION_ID_REQUIRED"
    ),
    propertyOrganizationId: requireText(
      mapping.propertyOrganizationId,
      "CHANNEX_ARI_PROPERTY_ORGANIZATION_ID_REQUIRED"
    ),
    propertyId: requireText(mapping.propertyId, "CHANNEX_ARI_PROPERTY_ID_REQUIRED"),
    externalRoomTypeId: requireText(
      mapping.externalRoomTypeId,
      "CHANNEX_ARI_ROOM_TYPE_MAPPING_MISSING"
    ),
    channexPropertyId: requireText(
      mapping.channexPropertyId,
      "CHANNEX_ARI_CHANNEX_PROPERTY_MAPPING_MISSING"
    ),
    channexRatePlanId: requireText(
      mapping.channexRatePlanId,
      "CHANNEX_ARI_RATE_PLAN_MAPPING_MISSING"
    ),
  };
  const validation = validateV1Mapping({
    connectionProvider: normalized.connectionProvider,
    connectionOrganizationId: normalized.connectionOrganizationId,
    propertyOrganizationId: normalized.propertyOrganizationId,
    propertyId: normalized.propertyId,
    externalRoomTypeId: normalized.externalRoomTypeId,
    channexPropertyId: normalized.channexPropertyId,
    channexRatePlanId: normalized.channexRatePlanId,
  });

  if (!validation.ok) {
    throw new Error(validation.reason);
  }

  if (normalized.propertyOrganizationId !== plan.organizationId) {
    throw new Error("CHANNEX_ARI_DELIVERY_ORGANIZATION_MISMATCH");
  }

  if (normalized.propertyId !== plan.propertyId) {
    throw new Error("CHANNEX_ARI_DELIVERY_PROPERTY_MISMATCH");
  }

  return normalized;
}

function getPayload(snapshot: ChannexAriDeliverySnapshot): DeliveryPayload {
  const payload = snapshot.data.payload as unknown;

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("CHANNEX_ARI_DELIVERY_PAYLOAD_INVALID");
  }

  assertExactObjectKeys(
    payload as Record<string, unknown>,
    ["values"],
    "CHANNEX_ARI_DELIVERY_PAYLOAD_FIELDS_INVALID"
  );

  const values = (payload as { values?: unknown }).values;

  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("CHANNEX_ARI_DELIVERY_PAYLOAD_VALUES_REQUIRED");
  }

  return { values: values as DeliveryPayloadValue[] };
}

function validateAvailabilityValue(input: {
  value: DeliveryPayloadValue;
  index: number;
  mapping: ChannexAriDeliveryMapping;
}): string {
  assertExactObjectKeys(
    input.value,
    ["property_id", "room_type_id", "date", "availability"],
    `CHANNEX_ARI_DELIVERY_AVAILABILITY_${input.index}_FIELDS_INVALID`
  );

  if (input.value.property_id !== input.mapping.channexPropertyId) {
    throw new Error(
      `CHANNEX_ARI_DELIVERY_AVAILABILITY_${input.index}_PROPERTY_MISMATCH`
    );
  }

  if (input.value.room_type_id !== input.mapping.externalRoomTypeId) {
    throw new Error(
      `CHANNEX_ARI_DELIVERY_AVAILABILITY_${input.index}_ROOM_TYPE_MISMATCH`
    );
  }

  if (input.value.availability !== 0 && input.value.availability !== 1) {
    throw new Error(
      `CHANNEX_ARI_DELIVERY_AVAILABILITY_${input.index}_VALUE_INVALID`
    );
  }

  return assertDateKey(
    String(input.value.date ?? ""),
    `availability_${input.index}_date`
  );
}

function validateRatesRestrictionsValue(input: {
  value: DeliveryPayloadValue;
  index: number;
  mapping: ChannexAriDeliveryMapping;
}): string {
  assertExactObjectKeys(
    input.value,
    [
      "property_id",
      "rate_plan_id",
      "date",
      "rate",
      "min_stay_arrival",
      "min_stay_through",
      "max_stay",
    ],
    `CHANNEX_ARI_DELIVERY_RATES_${input.index}_FIELDS_INVALID`
  );

  if (input.value.property_id !== input.mapping.channexPropertyId) {
    throw new Error(
      `CHANNEX_ARI_DELIVERY_RATES_${input.index}_PROPERTY_MISMATCH`
    );
  }

  if (input.value.rate_plan_id !== input.mapping.channexRatePlanId) {
    throw new Error(
      `CHANNEX_ARI_DELIVERY_RATES_${input.index}_RATE_PLAN_MISMATCH`
    );
  }

  assertPositiveRate(input.value.rate, input.index);
  const minStayArrival = assertPositiveInteger(
    input.value.min_stay_arrival,
    "MIN_STAY_ARRIVAL",
    input.index
  );
  const minStayThrough = assertPositiveInteger(
    input.value.min_stay_through,
    "MIN_STAY_THROUGH",
    input.index
  );
  const maxStay = assertNonNegativeInteger(
    input.value.max_stay,
    "MAX_STAY",
    input.index
  );

  if (
    maxStay > 0 &&
    (maxStay < minStayArrival || maxStay < minStayThrough)
  ) {
    throw new Error(
      `CHANNEX_ARI_DELIVERY_MAX_STAY_${input.index}_BELOW_MINIMUM`
    );
  }

  return assertDateKey(
    String(input.value.date ?? ""),
    `rates_${input.index}_date`
  );
}

function validateSnapshot(input: {
  snapshot: ChannexAriDeliverySnapshot;
  plan: ChannexAriCoalescingPlan;
  mapping: ChannexAriDeliveryMapping;
}): DeliveryPayload {
  if (input.snapshot.messageKind !== input.plan.messageKind) {
    throw new Error("CHANNEX_ARI_DELIVERY_SNAPSHOT_KIND_MISMATCH");
  }

  if (
    input.snapshot.data.dateFrom !== input.plan.dateFrom ||
    input.snapshot.data.dateToExclusive !== input.plan.dateToExclusive
  ) {
    throw new Error("CHANNEX_ARI_DELIVERY_SNAPSHOT_SCOPE_MISMATCH");
  }

  const payload = getPayload(input.snapshot);
  const payloadDates = payload.values.map((value, index) =>
    input.snapshot.messageKind === "AVAILABILITY"
      ? validateAvailabilityValue({
          value,
          index,
          mapping: input.mapping,
        })
      : validateRatesRestrictionsValue({
          value,
          index,
          mapping: input.mapping,
        })
  );
  const canonicalPayloadDates = normalizeDateKeys(payloadDates);

  if (canonicalPayloadDates.length !== payloadDates.length) {
    throw new Error("CHANNEX_ARI_DELIVERY_PAYLOAD_DUPLICATE_DATES");
  }

  assertSameStringArray(
    payloadDates,
    canonicalPayloadDates,
    "CHANNEX_ARI_DELIVERY_PAYLOAD_DATES_NOT_CANONICAL"
  );

  const expectedDates =
    input.plan.scope === "EXACT_DATES"
      ? input.plan.dateKeys
      : expandRange(input.plan.dateFrom, input.plan.dateToExclusive);

  assertSameStringArray(
    payloadDates,
    expectedDates,
    "CHANNEX_ARI_DELIVERY_PAYLOAD_SCOPE_MISMATCH"
  );

  if (input.plan.syncMode === "FULL" && payloadDates.length !== CHANNEX_ARI_FULL_SYNC_DAYS) {
    throw new Error("CHANNEX_ARI_FULL_SYNC_VALUE_COUNT_INVALID");
  }

  const integrity =
    calculateChannexAriCanonicalJsonIntegrity(payload);
  const payloadBytes = assertPayloadWithinLimit(payload);

  if (payloadBytes !== integrity.payloadBytes) {
    throw new Error(
      "CHANNEX_ARI_DELIVERY_PAYLOAD_BYTES_MISMATCH"
    );
  }

  const payloadHash = integrity.payloadHash;

  if (payloadBytes !== input.snapshot.data.payloadBytes) {
    throw new Error("CHANNEX_ARI_DELIVERY_PAYLOAD_BYTES_MISMATCH");
  }

  if (payloadHash !== input.snapshot.data.payloadHash) {
    throw new Error("CHANNEX_ARI_DELIVERY_PAYLOAD_HASH_MISMATCH");
  }

  if (payload.values.length !== input.snapshot.data.payloadValueCount) {
    throw new Error("CHANNEX_ARI_DELIVERY_VALUE_COUNT_MISMATCH");
  }

  return payload;
}

function normalizeInput(
  input: CreateChannexAriDeliveryInput
): NormalizedDeliveryInput {
  assertValidPlan(input.plan);
  const mapping = normalizeMapping(input.mapping, input.plan);
  const mergedEventIds = uniqueRequiredIds(
    input.plan.mergedEventIds,
    "CHANNEX_ARI_MERGED_EVENT_IDS"
  );
  const supersededEventIds = uniqueOptionalIds(
    input.supersededEventIds,
    "CHANNEX_ARI_SUPERSEDED_EVENT_IDS"
  );
  const overlap = supersededEventIds.find((eventId) =>
    mergedEventIds.includes(eventId)
  );

  if (overlap) {
    throw new Error("CHANNEX_ARI_DELIVERY_EVENT_ID_OVERLAP");
  }

  if (supersededEventIds.length > 0 && input.plan.syncMode !== "FULL") {
    throw new Error("CHANNEX_ARI_SUPERSESSION_FULL_PLAN_REQUIRED");
  }

  validateSnapshot({
    snapshot: input.snapshot,
    plan: input.plan,
    mapping,
  });

  return {
    plan: input.plan,
    mapping,
    snapshot: input.snapshot,
    mergedEventIds,
    supersededEventIds,
    queuedAt: assertValidInstant(
      input.queuedAt,
      "CHANNEX_ARI_DELIVERY_QUEUED_AT_INVALID"
    ),
  };
}

function validateOutboxPartition(input: {
  row: any;
  normalized: NormalizedDeliveryInput;
  expectedRole: "MERGED" | "SUPERSEDED";
}): void {
  const { row, normalized, expectedRole } = input;

  if (row.organizationId !== normalized.plan.organizationId) {
    throw new Error("CHANNEX_ARI_DELIVERY_OUTBOX_ORGANIZATION_MISMATCH");
  }

  if (row.propertyId !== normalized.plan.propertyId) {
    throw new Error("CHANNEX_ARI_DELIVERY_OUTBOX_PROPERTY_MISMATCH");
  }

  if (row.provider !== "CHANNEX") {
    throw new Error("CHANNEX_ARI_DELIVERY_OUTBOX_PROVIDER_MISMATCH");
  }

  if (row.messageKind !== normalized.plan.messageKind) {
    throw new Error("CHANNEX_ARI_DELIVERY_OUTBOX_MESSAGE_KIND_MISMATCH");
  }

  if (
    expectedRole === "MERGED" &&
    row.syncMode !== normalized.plan.syncMode
  ) {
    throw new Error("CHANNEX_ARI_DELIVERY_OUTBOX_SYNC_MODE_MISMATCH");
  }

  if (expectedRole === "SUPERSEDED" && row.syncMode !== "INCREMENTAL") {
    throw new Error("CHANNEX_ARI_SUPERSESSION_INCREMENTAL_REQUIRED");
  }
}

function assertExistingDeliveryMatches(input: {
  delivery: any;
  normalized: NormalizedDeliveryInput;
}): void {
  const { delivery, normalized } = input;

  if (
    delivery.organizationId !== normalized.plan.organizationId ||
    delivery.propertyId !== normalized.plan.propertyId ||
    delivery.connectionId !== normalized.mapping.connectionId ||
    delivery.listingId !== normalized.mapping.listingId ||
    delivery.messageKind !== normalized.plan.messageKind ||
    delivery.syncMode !== normalized.plan.syncMode ||
    delivery.scope !== normalized.plan.scope ||
    toDateKey(delivery.dateFrom, "date_from") !== normalized.plan.dateFrom ||
    toDateKey(delivery.dateToExclusive, "date_to_exclusive") !==
      normalized.plan.dateToExclusive ||
    delivery.payloadHash !== normalized.snapshot.data.payloadHash ||
    delivery.payloadBytes !== normalized.snapshot.data.payloadBytes ||
    delivery.payloadValueCount !== normalized.snapshot.data.payloadValueCount
  ) {
    throw new Error("CHANNEX_ARI_DELIVERY_IDEMPOTENCY_CONFLICT");
  }

  assertSameStringArray(
    delivery.dateKeys ?? [],
    normalized.plan.dateKeys,
    "CHANNEX_ARI_DELIVERY_IDEMPOTENCY_DATE_KEYS_CONFLICT"
  );
}

function resolveIdempotentDeliveryId(input: {
  rowsById: Map<string, any>;
  normalized: NormalizedDeliveryInput;
}): string | null {
  const { rowsById, normalized } = input;
  const expectedRows = [
    ...normalized.mergedEventIds.map((id) => ({ id, status: "MERGED" })),
    ...normalized.supersededEventIds.map((id) => ({ id, status: "SUPERSEDED" })),
  ];
  const deliveryIds = new Set<string>();
  let hasFreshRow = false;
  let hasPersistedRow = false;

  for (const expected of expectedRows) {
    const row = rowsById.get(expected.id);

    if (!row) {
      throw new Error("CHANNEX_ARI_DELIVERY_OUTBOX_EVENT_NOT_FOUND");
    }

    if (row.deliveryId) {
      hasPersistedRow = true;
      deliveryIds.add(String(row.deliveryId));

      if (row.status !== expected.status) {
        throw new Error("CHANNEX_ARI_DELIVERY_OUTBOX_STATE_CONFLICT");
      }
    } else {
      hasFreshRow = true;
    }
  }

  if (hasFreshRow && hasPersistedRow) {
    throw new Error("CHANNEX_ARI_DELIVERY_PARTIAL_IDEMPOTENCY_CONFLICT");
  }

  if (!hasPersistedRow) return null;

  if (deliveryIds.size !== 1) {
    throw new Error("CHANNEX_ARI_DELIVERY_IDEMPOTENCY_DELIVERY_CONFLICT");
  }

  return Array.from(deliveryIds)[0];
}

export async function createChannexAriDelivery(
  db: ChannexAriDeliveryDb,
  input: CreateChannexAriDeliveryInput
) {
  const normalized = normalizeInput(input);
  const payload = normalized.snapshot.data.payload as Prisma.InputJsonValue;
  const allEventIds = [
    ...normalized.mergedEventIds,
    ...normalized.supersededEventIds,
  ];

  return db.$transaction(async (tx) => {
    const rows = await tx.distributionOutboxEvent.findMany({
      where: {
        id: { in: allEventIds },
      },
      select: {
        id: true,
        organizationId: true,
        propertyId: true,
        provider: true,
        messageKind: true,
        syncMode: true,
        status: true,
        deliveryId: true,
      },
    });
    const rowsById = new Map(rows.map((row) => [row.id, row]));

    if (rowsById.size !== allEventIds.length) {
      throw new Error("CHANNEX_ARI_DELIVERY_OUTBOX_EVENT_NOT_FOUND");
    }

    for (const eventId of normalized.mergedEventIds) {
      validateOutboxPartition({
        row: rowsById.get(eventId),
        normalized,
        expectedRole: "MERGED",
      });
    }

    for (const eventId of normalized.supersededEventIds) {
      validateOutboxPartition({
        row: rowsById.get(eventId),
        normalized,
        expectedRole: "SUPERSEDED",
      });
    }

    const existingDeliveryId = resolveIdempotentDeliveryId({
      rowsById,
      normalized,
    });

    if (existingDeliveryId) {
      const existingDelivery = await tx.channexAriDelivery.findUnique({
        where: { id: existingDeliveryId },
      });

      if (!existingDelivery) {
        throw new Error("CHANNEX_ARI_DELIVERY_IDEMPOTENCY_RECORD_MISSING");
      }

      assertExistingDeliveryMatches({
        delivery: existingDelivery,
        normalized,
      });

      return {
        delivery: existingDelivery,
        reused: true,
        mergedEventCount: normalized.mergedEventIds.length,
        supersededEventCount: normalized.supersededEventIds.length,
      };
    }

    for (const eventId of normalized.mergedEventIds) {
      const row = rowsById.get(eventId)!;

      if (row.status !== "CLAIMED" || row.deliveryId) {
        throw new Error("CHANNEX_ARI_DELIVERY_MERGED_EVENT_NOT_CLAIMED");
      }
    }

    for (const eventId of normalized.supersededEventIds) {
      const row = rowsById.get(eventId)!;

      if (row.status !== "PENDING" || row.deliveryId) {
        throw new Error("CHANNEX_ARI_DELIVERY_SUPERSEDED_EVENT_NOT_PENDING");
      }
    }

    const delivery = await tx.channexAriDelivery.create({
      data: {
        organizationId: normalized.plan.organizationId,
        propertyId: normalized.plan.propertyId,
        connectionId: normalized.mapping.connectionId,
        listingId: normalized.mapping.listingId,
        messageKind: normalized.plan.messageKind,
        syncMode: normalized.plan.syncMode,
        scope: normalized.plan.scope,
        dateFrom: toDatabaseDate(normalized.plan.dateFrom),
        dateToExclusive: toDatabaseDate(normalized.plan.dateToExclusive),
        dateKeys: normalized.plan.dateKeys,
        status: "READY",
        payload,
        payloadHash: normalized.snapshot.data.payloadHash,
        payloadValueCount: normalized.snapshot.data.payloadValueCount,
        payloadBytes: normalized.snapshot.data.payloadBytes,
        attemptCount: 0,
        nextAttemptAt: normalized.queuedAt,
        queuedAt: normalized.queuedAt,
      },
    });

    const mergedResult = await tx.distributionOutboxEvent.updateMany({
      where: {
        id: { in: normalized.mergedEventIds },
        organizationId: normalized.plan.organizationId,
        propertyId: normalized.plan.propertyId,
        provider: "CHANNEX",
        messageKind: normalized.plan.messageKind,
        syncMode: normalized.plan.syncMode,
        status: "CLAIMED",
        deliveryId: null,
      },
      data: {
        status: "MERGED",
        deliveryId: delivery.id,
      },
    });

    if (mergedResult.count !== normalized.mergedEventIds.length) {
      throw new Error("CHANNEX_ARI_DELIVERY_MERGED_EVENT_RACE");
    }

    if (normalized.supersededEventIds.length > 0) {
      const supersededResult = await tx.distributionOutboxEvent.updateMany({
        where: {
          id: { in: normalized.supersededEventIds },
          organizationId: normalized.plan.organizationId,
          propertyId: normalized.plan.propertyId,
          provider: "CHANNEX",
          messageKind: normalized.plan.messageKind,
          syncMode: "INCREMENTAL",
          status: "PENDING",
          deliveryId: null,
        },
        data: {
          status: "SUPERSEDED",
          deliveryId: delivery.id,
        },
      });

      if (supersededResult.count !== normalized.supersededEventIds.length) {
        throw new Error("CHANNEX_ARI_DELIVERY_SUPERSEDED_EVENT_RACE");
      }
    }

    return {
      delivery,
      reused: false,
      mergedEventCount: normalized.mergedEventIds.length,
      supersededEventCount: normalized.supersededEventIds.length,
    };
  });
}
