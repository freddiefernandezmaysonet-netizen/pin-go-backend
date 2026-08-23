import {
  CHANNEX_ARI_FULL_SYNC_DAYS,
  addUtcDays,
  assertDateKey,
  countRangeDays,
  mergeDateRanges,
  normalizeDateKeys,
  type ChannexAriDateRange,
  type ChannexAriMessageKind,
  type ChannexAriSyncMode,
} from "./channex-ari-lifecycle.policy";
import type { ChannexAriRatesRestrictionsChangedField } from "./channex-ari-rates-restrictions-snapshot.policy";

export type ChannexAriOutboxScope =
  | "EXACT_DATES"
  | "DATE_RANGE"
  | "FULL_HORIZON";

export type ChannexAriCoalescingEvent = {
  id: string;
  organizationId: string;
  propertyId: string;
  provider: string;
  messageKind: ChannexAriMessageKind;
  syncMode: ChannexAriSyncMode;
  scope: ChannexAriOutboxScope;
  dateFrom: Date | string | null;
  dateToExclusive: Date | string | null;
  dateKeys: string[];
  changedFields?: ChannexAriRatesRestrictionsChangedField[];
  correlationId?: string | null;
  availableAt: Date;
  createdAt: Date;
};

export type ChannexAriCoalescingPlan = {
  organizationId: string;
  propertyId: string;
  provider: "CHANNEX";
  messageKind: ChannexAriMessageKind;
  syncMode: ChannexAriSyncMode;
  scope: ChannexAriOutboxScope;
  dateFrom: string;
  dateToExclusive: string;
  dateKeys: string[];
  changedFields?: ChannexAriRatesRestrictionsChangedField[];
  correlationId: string | null;
  correlationIds: string[];
  mergedEventIds: string[];
  snapshotAt: Date;
};

type NormalizedEvent = Omit<
  ChannexAriCoalescingEvent,
  "dateFrom" | "dateToExclusive" | "dateKeys" | "availableAt" | "createdAt"
> & {
  dateFrom: string;
  dateToExclusive: string;
  dateKeys: string[];
  availableAt: Date;
  createdAt: Date;
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

const CHANNEX_ARI_CHANGED_FIELD_ORDER: ChannexAriRatesRestrictionsChangedField[] = [
  "rate",
  "minStayArrival",
  "minStayThrough",
  "maxStay",
];

function normalizeChangedFields(input: {
  messageKind: ChannexAriMessageKind;
  syncMode: ChannexAriSyncMode;
  changedFields: ChannexAriRatesRestrictionsChangedField[] | undefined;
}): ChannexAriRatesRestrictionsChangedField[] | undefined {
  if (input.changedFields === undefined) return undefined;

  if (input.messageKind !== "RATES_RESTRICTIONS") {
    throw new Error("CHANNEX_ARI_AVAILABILITY_CHANGED_FIELDS_NOT_ALLOWED");
  }

  if (input.syncMode === "FULL") {
    throw new Error("CHANNEX_ARI_FULL_SYNC_CHANGED_FIELDS_NOT_ALLOWED");
  }

  if (!Array.isArray(input.changedFields) || input.changedFields.length === 0) {
    throw new Error("CHANNEX_ARI_CHANGED_FIELDS_REQUIRED");
  }

  const unique = Array.from(new Set(input.changedFields));

  if (
    unique.length !== input.changedFields.length ||
    unique.some((field) => !CHANNEX_ARI_CHANGED_FIELD_ORDER.includes(field))
  ) {
    throw new Error("CHANNEX_ARI_CHANGED_FIELDS_INVALID");
  }

  return CHANNEX_ARI_CHANGED_FIELD_ORDER.filter((field) =>
    unique.includes(field)
  );
}

function assertValidInstant(value: Date, errorCode: string): Date {
  const normalized = new Date(value);

  if (Number.isNaN(normalized.getTime())) {
    throw new Error(errorCode);
  }

  return normalized;
}

function toDateKey(value: Date | string | null, fieldName: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`CHANNEX_ARI_INVALID_${fieldName.toUpperCase()}`);
    }

    return assertDateKey(value.toISOString().slice(0, 10), fieldName);
  }

  return assertDateKey(String(value ?? ""), fieldName);
}

function expandRange(range: ChannexAriDateRange): string[] {
  const days = countRangeDays(range);

  if (days > CHANNEX_ARI_FULL_SYNC_DAYS) {
    throw new Error("CHANNEX_ARI_COALESCED_RANGE_EXCEEDS_HORIZON");
  }

  return Array.from({ length: days }, (_, index) =>
    addUtcDays(range.from, index)
  );
}

function normalizeEvent(event: ChannexAriCoalescingEvent): NormalizedEvent {
  const id = requireText(event.id, "CHANNEX_ARI_OUTBOX_EVENT_ID_REQUIRED");
  const organizationId = requireText(
    event.organizationId,
    "CHANNEX_ARI_ORGANIZATION_ID_REQUIRED"
  );
  const propertyId = requireText(
    event.propertyId,
    "CHANNEX_ARI_PROPERTY_ID_REQUIRED"
  );
  const provider = requireText(event.provider, "CHANNEX_ARI_PROVIDER_REQUIRED");
  const availableAt = assertValidInstant(
    event.availableAt,
    "CHANNEX_ARI_OUTBOX_AVAILABLE_AT_INVALID"
  );
  const createdAt = assertValidInstant(
    event.createdAt,
    "CHANNEX_ARI_OUTBOX_CREATED_AT_INVALID"
  );
  const dateFrom = toDateKey(event.dateFrom, "date_from");
  const dateToExclusive = toDateKey(
    event.dateToExclusive,
    "date_to_exclusive"
  );
  const range = { from: dateFrom, toExclusive: dateToExclusive };
  const rangeDays = countRangeDays(range);

  if (rangeDays > CHANNEX_ARI_FULL_SYNC_DAYS) {
    throw new Error("CHANNEX_ARI_OUTBOX_SCOPE_EXCEEDS_HORIZON");
  }

  if (provider !== "CHANNEX") {
    throw new Error("CHANNEX_ARI_PROVIDER_MISMATCH");
  }

  if (
    event.messageKind !== "AVAILABILITY" &&
    event.messageKind !== "RATES_RESTRICTIONS"
  ) {
    throw new Error("CHANNEX_ARI_INVALID_MESSAGE_KIND");
  }

  if (event.syncMode !== "INCREMENTAL" && event.syncMode !== "FULL") {
    throw new Error("CHANNEX_ARI_INVALID_SYNC_MODE");
  }

  const dateKeys = normalizeDateKeys(event.dateKeys ?? []);
  const changedFields = normalizeChangedFields({
    messageKind: event.messageKind,
    syncMode: event.syncMode,
    changedFields: event.changedFields,
  });

  if (event.syncMode === "FULL") {
    if (event.scope !== "FULL_HORIZON") {
      throw new Error("CHANNEX_ARI_FULL_SYNC_SCOPE_INVALID");
    }

    if (dateKeys.length > 0) {
      throw new Error("CHANNEX_ARI_FULL_SYNC_DATE_KEYS_NOT_ALLOWED");
    }

    if (rangeDays !== CHANNEX_ARI_FULL_SYNC_DAYS) {
      throw new Error("CHANNEX_ARI_FULL_SYNC_RANGE_INVALID");
    }

    if (!normalizeOptionalText(event.correlationId)) {
      throw new Error("CHANNEX_ARI_FULL_SYNC_CORRELATION_ID_REQUIRED");
    }
  } else if (event.scope === "EXACT_DATES") {
    if (dateKeys.length === 0) {
      throw new Error("CHANNEX_ARI_EXACT_DATE_KEYS_REQUIRED");
    }

    const expectedFrom = dateKeys[0];
    const expectedToExclusive = addUtcDays(dateKeys[dateKeys.length - 1], 1);

    if (dateFrom !== expectedFrom || dateToExclusive !== expectedToExclusive) {
      throw new Error("CHANNEX_ARI_EXACT_DATE_BOUNDS_MISMATCH");
    }
  } else if (event.scope === "DATE_RANGE") {
    if (dateKeys.length > 0) {
      throw new Error("CHANNEX_ARI_DATE_RANGE_KEYS_NOT_ALLOWED");
    }
  } else {
    throw new Error("CHANNEX_ARI_INCREMENTAL_SCOPE_INVALID");
  }

  return {
    ...event,
    id,
    organizationId,
    propertyId,
    provider,
    correlationId: normalizeOptionalText(event.correlationId),
    dateFrom,
    dateToExclusive,
    dateKeys,
    ...(changedFields !== undefined ? { changedFields } : {}),
    availableAt,
    createdAt,
  };
}

function assertOnePartition(events: NormalizedEvent[]): void {
  const first = events[0];

  for (const event of events.slice(1)) {
    if (event.organizationId !== first.organizationId) {
      throw new Error("CHANNEX_ARI_COALESCE_ORGANIZATION_MISMATCH");
    }

    if (event.propertyId !== first.propertyId) {
      throw new Error("CHANNEX_ARI_COALESCE_PROPERTY_MISMATCH");
    }

    if (event.provider !== first.provider) {
      throw new Error("CHANNEX_ARI_COALESCE_PROVIDER_MISMATCH");
    }

    if (event.messageKind !== first.messageKind) {
      throw new Error("CHANNEX_ARI_COALESCE_MESSAGE_KIND_MISMATCH");
    }

    if (event.syncMode !== first.syncMode) {
      throw new Error("CHANNEX_ARI_COALESCE_SYNC_MODE_MISMATCH");
    }
  }
}

function sortEvents(events: NormalizedEvent[]): NormalizedEvent[] {
  return [...events].sort((left, right) => {
    const createdAtDifference = left.createdAt.getTime() - right.createdAt.getTime();

    return createdAtDifference !== 0
      ? createdAtDifference
      : left.id.localeCompare(right.id);
  });
}

function buildIncrementalPlan(input: {
  events: NormalizedEvent[];
  snapshotAt: Date;
}): ChannexAriCoalescingPlan {
  const first = input.events[0];
  const exactDateKeys: string[] = [];
  const ranges: ChannexAriDateRange[] = [];
  let hasExactDateScope = false;

  for (const event of input.events) {
    const range = {
      from: event.dateFrom,
      toExclusive: event.dateToExclusive,
    };

    ranges.push(range);

    if (event.scope === "EXACT_DATES") {
      hasExactDateScope = true;
      exactDateKeys.push(...event.dateKeys);
    } else {
      exactDateKeys.push(...expandRange(range));
    }
  }

  const dateKeys = normalizeDateKeys(exactDateKeys);

  if (dateKeys.length === 0) {
    throw new Error("CHANNEX_ARI_COALESCED_DATE_KEYS_REQUIRED");
  }

  if (dateKeys.length > CHANNEX_ARI_FULL_SYNC_DAYS) {
    throw new Error("CHANNEX_ARI_COALESCED_DATE_KEYS_EXCEED_HORIZON");
  }

  const dateFrom = dateKeys[0];
  const dateToExclusive = addUtcDays(dateKeys[dateKeys.length - 1], 1);

  if (
    countRangeDays({ from: dateFrom, toExclusive: dateToExclusive }) >
    CHANNEX_ARI_FULL_SYNC_DAYS
  ) {
    throw new Error("CHANNEX_ARI_COALESCED_SCOPE_EXCEEDS_HORIZON");
  }

  const mergedRanges = mergeDateRanges(ranges);
  const canRemainRange = !hasExactDateScope && mergedRanges.length === 1;
  const correlationIds = normalizeDateKeys([]) as string[];
  const everyEventHasChangedFields = input.events.every(
    (event) => event.changedFields !== undefined
  );
  const changedFields = everyEventHasChangedFields
    ? CHANNEX_ARI_CHANGED_FIELD_ORDER.filter((field) =>
        input.events.some((event) => event.changedFields?.includes(field))
      )
    : undefined;

  for (const event of input.events) {
    const correlationId = normalizeOptionalText(event.correlationId);

    if (correlationId && !correlationIds.includes(correlationId)) {
      correlationIds.push(correlationId);
    }
  }

  correlationIds.sort();

  return {
    organizationId: first.organizationId,
    propertyId: first.propertyId,
    provider: "CHANNEX",
    messageKind: first.messageKind,
    syncMode: "INCREMENTAL",
    scope: canRemainRange ? "DATE_RANGE" : "EXACT_DATES",
    dateFrom,
    dateToExclusive,
    dateKeys: canRemainRange ? [] : dateKeys,
    ...(changedFields !== undefined ? { changedFields } : {}),
    correlationId: correlationIds.length === 1 ? correlationIds[0] : null,
    correlationIds,
    mergedEventIds: input.events.map((event) => event.id),
    snapshotAt: input.snapshotAt,
  };
}

function buildFullPlan(input: {
  events: NormalizedEvent[];
  snapshotAt: Date;
}): ChannexAriCoalescingPlan {
  const first = input.events[0];
  const correlationIds = Array.from(
    new Set(
      input.events.map((event) =>
        requireText(
          event.correlationId,
          "CHANNEX_ARI_FULL_SYNC_CORRELATION_ID_REQUIRED"
        )
      )
    )
  ).sort();

  if (correlationIds.length !== 1) {
    throw new Error("CHANNEX_ARI_FULL_SYNC_CORRELATION_CONFLICT");
  }

  for (const event of input.events.slice(1)) {
    if (
      event.dateFrom !== first.dateFrom ||
      event.dateToExclusive !== first.dateToExclusive
    ) {
      throw new Error("CHANNEX_ARI_FULL_SYNC_RANGE_CONFLICT");
    }
  }

  return {
    organizationId: first.organizationId,
    propertyId: first.propertyId,
    provider: "CHANNEX",
    messageKind: first.messageKind,
    syncMode: "FULL",
    scope: "FULL_HORIZON",
    dateFrom: first.dateFrom,
    dateToExclusive: first.dateToExclusive,
    dateKeys: [],
    correlationId: correlationIds[0],
    correlationIds,
    mergedEventIds: input.events.map((event) => event.id),
    snapshotAt: input.snapshotAt,
  };
}

export function buildChannexAriCoalescingPlan(input: {
  events: ChannexAriCoalescingEvent[];
  snapshotAt?: Date;
}): ChannexAriCoalescingPlan {
  if (!Array.isArray(input.events) || input.events.length === 0) {
    throw new Error("CHANNEX_ARI_COALESCE_EVENTS_REQUIRED");
  }

  const snapshotAt = assertValidInstant(
    input.snapshotAt ?? new Date(),
    "CHANNEX_ARI_COALESCE_SNAPSHOT_AT_INVALID"
  );
  const events = sortEvents(input.events.map(normalizeEvent));
  const uniqueEventIds = new Set(events.map((event) => event.id));

  if (uniqueEventIds.size !== events.length) {
    throw new Error("CHANNEX_ARI_COALESCE_DUPLICATE_EVENT_ID");
  }

  assertOnePartition(events);

  for (const event of events) {
    if (event.availableAt.getTime() > snapshotAt.getTime()) {
      throw new Error("CHANNEX_ARI_COALESCE_EVENT_NOT_READY");
    }
  }

  return events[0].syncMode === "FULL"
    ? buildFullPlan({ events, snapshotAt })
    : buildIncrementalPlan({ events, snapshotAt });
}

function scopeIsInsideFullHorizon(input: {
  event: NormalizedEvent;
  fullFrom: string;
  fullToExclusive: string;
}): boolean {
  if (input.event.scope === "EXACT_DATES") {
    return input.event.dateKeys.every(
      (dateKey) =>
        dateKey >= input.fullFrom && dateKey < input.fullToExclusive
    );
  }

  return (
    input.event.dateFrom >= input.fullFrom &&
    input.event.dateToExclusive <= input.fullToExclusive
  );
}

export function planFullSyncIncrementalSupersession(input: {
  fullPlan: ChannexAriCoalescingPlan;
  pendingIncrementalEvents: ChannexAriCoalescingEvent[];
  snapshotAt?: Date;
}): {
  supersededEventIds: string[];
  retainedEventIds: string[];
} {
  if (input.fullPlan.syncMode !== "FULL") {
    throw new Error("CHANNEX_ARI_SUPERSESSION_FULL_PLAN_REQUIRED");
  }

  const snapshotAt = assertValidInstant(
    input.snapshotAt ?? input.fullPlan.snapshotAt,
    "CHANNEX_ARI_SUPERSESSION_SNAPSHOT_AT_INVALID"
  );
  const events = sortEvents(input.pendingIncrementalEvents.map(normalizeEvent));
  const supersededEventIds: string[] = [];
  const retainedEventIds: string[] = [];

  for (const event of events) {
    if (event.organizationId !== input.fullPlan.organizationId) {
      throw new Error("CHANNEX_ARI_SUPERSESSION_ORGANIZATION_MISMATCH");
    }

    if (event.propertyId !== input.fullPlan.propertyId) {
      throw new Error("CHANNEX_ARI_SUPERSESSION_PROPERTY_MISMATCH");
    }

    if (event.provider !== input.fullPlan.provider) {
      throw new Error("CHANNEX_ARI_SUPERSESSION_PROVIDER_MISMATCH");
    }

    if (event.messageKind !== input.fullPlan.messageKind) {
      throw new Error("CHANNEX_ARI_SUPERSESSION_MESSAGE_KIND_MISMATCH");
    }

    if (event.syncMode !== "INCREMENTAL") {
      throw new Error("CHANNEX_ARI_SUPERSESSION_INCREMENTAL_REQUIRED");
    }

    const createdBeforeOrAtSnapshot =
      event.createdAt.getTime() <= snapshotAt.getTime();
    const coveredByFullHorizon = scopeIsInsideFullHorizon({
      event,
      fullFrom: input.fullPlan.dateFrom,
      fullToExclusive: input.fullPlan.dateToExclusive,
    });

    if (createdBeforeOrAtSnapshot && coveredByFullHorizon) {
      supersededEventIds.push(event.id);
    } else {
      retainedEventIds.push(event.id);
    }
  }

  return {
    supersededEventIds,
    retainedEventIds,
  };
}
