import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChannexAriCoalescingPlan,
  planFullSyncIncrementalSupersession,
  type ChannexAriCoalescingEvent,
} from "./channex-ari-coalescing.policy";

const SNAPSHOT_AT = new Date("2026-07-28T12:00:00.000Z");

function incrementalEvent(
  overrides: Partial<ChannexAriCoalescingEvent> & { id: string }
): ChannexAriCoalescingEvent {
  return {
    id: overrides.id,
    organizationId: "org-1",
    propertyId: "property-1",
    provider: "CHANNEX",
    messageKind: "AVAILABILITY",
    syncMode: "INCREMENTAL",
    scope: "EXACT_DATES",
    dateFrom: "2026-08-01",
    dateToExclusive: "2026-08-02",
    dateKeys: ["2026-08-01"],
    correlationId: null,
    availableAt: new Date("2026-07-28T11:59:00.000Z"),
    createdAt: new Date("2026-07-28T11:58:00.000Z"),
    ...overrides,
  };
}

function fullEvent(
  overrides: Partial<ChannexAriCoalescingEvent> & { id: string }
): ChannexAriCoalescingEvent {
  return {
    id: overrides.id,
    organizationId: "org-1",
    propertyId: "property-1",
    provider: "CHANNEX",
    messageKind: "AVAILABILITY",
    syncMode: "FULL",
    scope: "FULL_HORIZON",
    dateFrom: "2026-07-28",
    dateToExclusive: "2027-12-10",
    dateKeys: [],
    correlationId: "full-sync-1",
    availableAt: new Date("2026-07-28T11:59:00.000Z"),
    createdAt: new Date("2026-07-28T11:58:00.000Z"),
    ...overrides,
  };
}

test("unions exact dates deterministically and preserves correlation evidence", () => {
  const plan = buildChannexAriCoalescingPlan({
    snapshotAt: SNAPSHOT_AT,
    events: [
      incrementalEvent({
        id: "event-2",
        dateFrom: "2026-08-02",
        dateToExclusive: "2026-08-05",
        dateKeys: ["2026-08-04", "2026-08-02", "2026-08-04"],
        correlationId: "correlation-b",
        createdAt: new Date("2026-07-28T11:58:02.000Z"),
      }),
      incrementalEvent({
        id: "event-1",
        dateFrom: "2026-08-01",
        dateToExclusive: "2026-08-04",
        dateKeys: ["2026-08-03", "2026-08-01"],
        correlationId: "correlation-a",
        createdAt: new Date("2026-07-28T11:58:01.000Z"),
      }),
    ],
  });

  assert.deepEqual(plan, {
    organizationId: "org-1",
    propertyId: "property-1",
    provider: "CHANNEX",
    messageKind: "AVAILABILITY",
    syncMode: "INCREMENTAL",
    scope: "EXACT_DATES",
    dateFrom: "2026-08-01",
    dateToExclusive: "2026-08-05",
    dateKeys: ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"],
    correlationId: null,
    correlationIds: ["correlation-a", "correlation-b"],
    mergedEventIds: ["event-1", "event-2"],
    snapshotAt: SNAPSHOT_AT,
  });
});

test("certification deltas union changed fields deterministically", () => {
  const plan = buildChannexAriCoalescingPlan({
    snapshotAt: SNAPSHOT_AT,
    events: [
      incrementalEvent({
        id: "restriction-event",
        messageKind: "RATES_RESTRICTIONS",
        dateFrom: "2026-11-02",
        dateToExclusive: "2026-11-03",
        dateKeys: ["2026-11-02"],
        changedFields: ["minStayThrough", "minStayArrival"],
        createdAt: new Date("2026-07-28T11:58:02.000Z"),
      } as any),
      incrementalEvent({
        id: "rate-event",
        messageKind: "RATES_RESTRICTIONS",
        dateFrom: "2026-11-01",
        dateToExclusive: "2026-11-02",
        dateKeys: ["2026-11-01"],
        changedFields: ["rate"],
        createdAt: new Date("2026-07-28T11:58:01.000Z"),
      } as any),
    ],
  });

  assert.deepEqual((plan as any).changedFields, [
    "rate",
    "minStayArrival",
    "minStayThrough",
  ]);
  assert.deepEqual(plan.mergedEventIds, ["rate-event", "restriction-event"]);
});

test("keeps one merged DATE_RANGE for overlapping and adjacent ranges", () => {
  const plan = buildChannexAriCoalescingPlan({
    snapshotAt: SNAPSHOT_AT,
    events: [
      incrementalEvent({
        id: "range-1",
        scope: "DATE_RANGE",
        dateFrom: "2026-08-01",
        dateToExclusive: "2026-08-04",
        dateKeys: [],
        correlationId: "pricing-1",
      }),
      incrementalEvent({
        id: "range-2",
        scope: "DATE_RANGE",
        dateFrom: "2026-08-04",
        dateToExclusive: "2026-08-07",
        dateKeys: [],
        correlationId: "pricing-1",
        createdAt: new Date("2026-07-28T11:58:01.000Z"),
      }),
      incrementalEvent({
        id: "range-3",
        scope: "DATE_RANGE",
        dateFrom: "2026-08-06",
        dateToExclusive: "2026-08-09",
        dateKeys: [],
        correlationId: "pricing-1",
        createdAt: new Date("2026-07-28T11:58:02.000Z"),
      }),
    ],
  });

  assert.equal(plan.scope, "DATE_RANGE");
  assert.equal(plan.dateFrom, "2026-08-01");
  assert.equal(plan.dateToExclusive, "2026-08-09");
  assert.deepEqual(plan.dateKeys, []);
  assert.equal(plan.correlationId, "pricing-1");
  assert.deepEqual(plan.correlationIds, ["pricing-1"]);
});

test("converts disjoint ranges into one exact-date canonical plan", () => {
  const plan = buildChannexAriCoalescingPlan({
    snapshotAt: SNAPSHOT_AT,
    events: [
      incrementalEvent({
        id: "range-1",
        scope: "DATE_RANGE",
        dateFrom: "2026-08-01",
        dateToExclusive: "2026-08-03",
        dateKeys: [],
      }),
      incrementalEvent({
        id: "range-2",
        scope: "DATE_RANGE",
        dateFrom: "2026-08-05",
        dateToExclusive: "2026-08-07",
        dateKeys: [],
        createdAt: new Date("2026-07-28T11:58:01.000Z"),
      }),
    ],
  });

  assert.equal(plan.scope, "EXACT_DATES");
  assert.equal(plan.dateFrom, "2026-08-01");
  assert.equal(plan.dateToExclusive, "2026-08-07");
  assert.deepEqual(plan.dateKeys, [
    "2026-08-01",
    "2026-08-02",
    "2026-08-05",
    "2026-08-06",
  ]);
});

test("combines exact dates and ranges as exact canonical dates", () => {
  const plan = buildChannexAriCoalescingPlan({
    snapshotAt: SNAPSHOT_AT,
    events: [
      incrementalEvent({
        id: "exact-1",
        dateFrom: "2026-08-01",
        dateToExclusive: "2026-08-04",
        dateKeys: ["2026-08-01", "2026-08-03"],
      }),
      incrementalEvent({
        id: "range-1",
        scope: "DATE_RANGE",
        dateFrom: "2026-08-02",
        dateToExclusive: "2026-08-05",
        dateKeys: [],
        createdAt: new Date("2026-07-28T11:58:01.000Z"),
      }),
    ],
  });

  assert.equal(plan.scope, "EXACT_DATES");
  assert.deepEqual(plan.dateKeys, [
    "2026-08-01",
    "2026-08-02",
    "2026-08-03",
    "2026-08-04",
  ]);
});

test("rejects events that are not ready at the snapshot boundary", () => {
  assert.throws(
    () =>
      buildChannexAriCoalescingPlan({
        snapshotAt: SNAPSHOT_AT,
        events: [
          incrementalEvent({
            id: "future-event",
            availableAt: new Date("2026-07-28T12:00:01.000Z"),
          }),
        ],
      }),
    /CHANNEX_ARI_COALESCE_EVENT_NOT_READY/
  );
});

test("rejects mixed partitions and duplicate event identities", () => {
  assert.throws(
    () =>
      buildChannexAriCoalescingPlan({
        snapshotAt: SNAPSHOT_AT,
        events: [
          incrementalEvent({ id: "event-1" }),
          incrementalEvent({
            id: "event-2",
            propertyId: "property-2",
          }),
        ],
      }),
    /CHANNEX_ARI_COALESCE_PROPERTY_MISMATCH/
  );

  assert.throws(
    () =>
      buildChannexAriCoalescingPlan({
        snapshotAt: SNAPSHOT_AT,
        events: [
          incrementalEvent({ id: "event-1" }),
          incrementalEvent({
            id: "event-2",
            messageKind: "RATES_RESTRICTIONS",
          }),
        ],
      }),
    /CHANNEX_ARI_COALESCE_MESSAGE_KIND_MISMATCH/
  );

  assert.throws(
    () =>
      buildChannexAriCoalescingPlan({
        snapshotAt: SNAPSHOT_AT,
        events: [
          incrementalEvent({ id: "duplicate" }),
          incrementalEvent({
            id: "duplicate",
            createdAt: new Date("2026-07-28T11:58:01.000Z"),
          }),
        ],
      }),
    /CHANNEX_ARI_COALESCE_DUPLICATE_EVENT_ID/
  );
});

test("rejects malformed exact-date and range scopes", () => {
  assert.throws(
    () =>
      buildChannexAriCoalescingPlan({
        snapshotAt: SNAPSHOT_AT,
        events: [
          incrementalEvent({
            id: "exact-bounds",
            dateFrom: "2026-08-02",
            dateToExclusive: "2026-08-04",
            dateKeys: ["2026-08-01", "2026-08-03"],
          }),
        ],
      }),
    /CHANNEX_ARI_EXACT_DATE_BOUNDS_MISMATCH/
  );

  assert.throws(
    () =>
      buildChannexAriCoalescingPlan({
        snapshotAt: SNAPSHOT_AT,
        events: [
          incrementalEvent({
            id: "range-keys",
            scope: "DATE_RANGE",
            dateFrom: "2026-08-01",
            dateToExclusive: "2026-08-03",
            dateKeys: ["2026-08-01"],
          }),
        ],
      }),
    /CHANNEX_ARI_DATE_RANGE_KEYS_NOT_ALLOWED/
  );
});

test("builds one exact 500-day Full Sync plan", () => {
  const plan = buildChannexAriCoalescingPlan({
    snapshotAt: SNAPSHOT_AT,
    events: [
      fullEvent({ id: "full-2", createdAt: new Date("2026-07-28T11:58:02.000Z") }),
      fullEvent({ id: "full-1", createdAt: new Date("2026-07-28T11:58:01.000Z") }),
    ],
  });

  assert.deepEqual(plan, {
    organizationId: "org-1",
    propertyId: "property-1",
    provider: "CHANNEX",
    messageKind: "AVAILABILITY",
    syncMode: "FULL",
    scope: "FULL_HORIZON",
    dateFrom: "2026-07-28",
    dateToExclusive: "2027-12-10",
    dateKeys: [],
    correlationId: "full-sync-1",
    correlationIds: ["full-sync-1"],
    mergedEventIds: ["full-1", "full-2"],
    snapshotAt: SNAPSHOT_AT,
  });
});

test("rejects Full Sync correlation and horizon conflicts", () => {
  assert.throws(
    () =>
      buildChannexAriCoalescingPlan({
        snapshotAt: SNAPSHOT_AT,
        events: [
          fullEvent({ id: "full-1" }),
          fullEvent({
            id: "full-2",
            correlationId: "full-sync-2",
            createdAt: new Date("2026-07-28T11:58:01.000Z"),
          }),
        ],
      }),
    /CHANNEX_ARI_FULL_SYNC_CORRELATION_CONFLICT/
  );

  assert.throws(
    () =>
      buildChannexAriCoalescingPlan({
        snapshotAt: SNAPSHOT_AT,
        events: [
          fullEvent({ id: "full-1" }),
          fullEvent({
            id: "full-2",
            dateFrom: "2026-07-29",
            dateToExclusive: "2027-12-11",
            createdAt: new Date("2026-07-28T11:58:01.000Z"),
          }),
        ],
      }),
    /CHANNEX_ARI_FULL_SYNC_RANGE_CONFLICT/
  );
});

test("Full Sync supersedes only older incrementals inside its horizon", () => {
  const fullPlan = buildChannexAriCoalescingPlan({
    snapshotAt: SNAPSHOT_AT,
    events: [fullEvent({ id: "full-1" })],
  });

  const result = planFullSyncIncrementalSupersession({
    fullPlan,
    pendingIncrementalEvents: [
      incrementalEvent({
        id: "inside-before",
        dateFrom: "2026-08-01",
        dateToExclusive: "2026-08-03",
        dateKeys: ["2026-08-01", "2026-08-02"],
        createdAt: new Date("2026-07-28T11:59:59.000Z"),
      }),
      incrementalEvent({
        id: "inside-after",
        dateFrom: "2026-08-03",
        dateToExclusive: "2026-08-04",
        dateKeys: ["2026-08-03"],
        createdAt: new Date("2026-07-28T12:00:01.000Z"),
      }),
      incrementalEvent({
        id: "outside-before",
        dateFrom: "2027-12-10",
        dateToExclusive: "2027-12-11",
        dateKeys: ["2027-12-10"],
        createdAt: new Date("2026-07-28T11:59:58.000Z"),
      }),
    ],
  });

  assert.deepEqual(result, {
    supersededEventIds: ["inside-before"],
    retainedEventIds: ["outside-before", "inside-after"],
  });
});

test("supersession enforces the Full Sync partition and incremental mode", () => {
  const fullPlan = buildChannexAriCoalescingPlan({
    snapshotAt: SNAPSHOT_AT,
    events: [fullEvent({ id: "full-1" })],
  });

  assert.throws(
    () =>
      planFullSyncIncrementalSupersession({
        fullPlan,
        pendingIncrementalEvents: [
          incrementalEvent({
            id: "property-mismatch",
            propertyId: "property-2",
          }),
        ],
      }),
    /CHANNEX_ARI_SUPERSESSION_PROPERTY_MISMATCH/
  );

  assert.throws(
    () =>
      planFullSyncIncrementalSupersession({
        fullPlan,
        pendingIncrementalEvents: [fullEvent({ id: "not-incremental" })],
      }),
    /CHANNEX_ARI_SUPERSESSION_INCREMENTAL_REQUIRED/
  );
});
