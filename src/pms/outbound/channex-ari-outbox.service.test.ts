import assert from "node:assert/strict";
import test from "node:test";

import {
  createChannexAriOutboxEvent,
  type CreateChannexAriOutboxEventInput,
} from "./channex-ari-outbox.service";

function createDbMock() {
  const writes: Array<{ data: Record<string, unknown> }> = [];

  const db = {
    distributionOutboxEvent: {
      create: async (args: { data: Record<string, unknown> }) => {
        writes.push(args);

        return {
          id: `outbox-${writes.length}`,
          ...args.data,
        };
      },
    },
  } as any;

  return { db, writes };
}

async function assertRejectsWithoutWrite(
  input: CreateChannexAriOutboxEventInput,
  expectedError: RegExp
) {
  const { db, writes } = createDbMock();

  await assert.rejects(
    () => createChannexAriOutboxEvent(db, input),
    expectedError
  );
  assert.equal(writes.length, 0);
}

test("creates a normalized incremental exact-date Availability intent", async () => {
  const { db, writes } = createDbMock();
  const now = new Date("2026-07-28T12:00:00.000Z");

  const result = await createChannexAriOutboxEvent(db, {
    organizationId: " org-1 ",
    propertyId: " property-1 ",
    messageKind: "AVAILABILITY",
    trigger: " RESERVATION_CREATED ",
    sourceEntityType: " RESERVATION ",
    sourceEntityId: " reservation-1 ",
    dateKeys: ["2026-08-03", "2026-08-01", "2026-08-03"],
    now,
  });

  assert.equal(result.id, "outbox-1");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].data, {
    organizationId: "org-1",
    propertyId: "property-1",
    provider: "CHANNEX",
    messageKind: "AVAILABILITY",
    syncMode: "INCREMENTAL",
    scope: "EXACT_DATES",
    dateFrom: new Date("2026-08-01T00:00:00.000Z"),
    dateToExclusive: new Date("2026-08-04T00:00:00.000Z"),
    dateKeys: ["2026-08-01", "2026-08-03"],
    trigger: "RESERVATION_CREATED",
    sourceEntityType: "RESERVATION",
    sourceEntityId: "reservation-1",
    correlationId: null,
    status: "PENDING",
    availableAt: new Date("2026-07-28T12:00:30.000Z"),
  });
});

test("creates an incremental date-range Rates & Restrictions intent", async () => {
  const { db, writes } = createDbMock();
  const now = new Date("2026-07-28T12:00:00.000Z");

  await createChannexAriOutboxEvent(db, {
    organizationId: "org-1",
    propertyId: "property-1",
    messageKind: "RATES_RESTRICTIONS",
    trigger: "NIGHTLY_RATE_UPDATE",
    correlationId: "pricing-batch-1",
    dateRange: {
      from: "2026-09-01",
      toExclusive: "2026-09-04",
    },
    now,
    coalesceMs: 60_000,
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].data.scope, "DATE_RANGE");
  assert.equal(writes[0].data.syncMode, "INCREMENTAL");
  assert.deepEqual(writes[0].data.dateKeys, []);
  assert.deepEqual(
    writes[0].data.dateFrom,
    new Date("2026-09-01T00:00:00.000Z")
  );
  assert.deepEqual(
    writes[0].data.dateToExclusive,
    new Date("2026-09-04T00:00:00.000Z")
  );
  assert.deepEqual(
    writes[0].data.availableAt,
    new Date("2026-07-28T12:01:00.000Z")
  );
});

test("creates an immediate exact 500-day Full Sync intent", async () => {
  const { db, writes } = createDbMock();
  const now = new Date("2026-07-28T12:00:00.000Z");

  await createChannexAriOutboxEvent(db, {
    organizationId: "org-1",
    propertyId: "property-1",
    messageKind: "AVAILABILITY",
    syncMode: "FULL",
    trigger: "DISTRIBUTION_ENABLEMENT",
    correlationId: "full-sync-1",
    todayDateKey: "2026-07-28",
    now,
    coalesceMs: 0,
  });

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].data, {
    organizationId: "org-1",
    propertyId: "property-1",
    provider: "CHANNEX",
    messageKind: "AVAILABILITY",
    syncMode: "FULL",
    scope: "FULL_HORIZON",
    dateFrom: new Date("2026-07-28T00:00:00.000Z"),
    dateToExclusive: new Date("2027-12-10T00:00:00.000Z"),
    dateKeys: [],
    trigger: "DISTRIBUTION_ENABLEMENT",
    sourceEntityType: null,
    sourceEntityId: null,
    correlationId: "full-sync-1",
    status: "PENDING",
    availableAt: now,
  });
});

test("requires exactly one incremental scope", async () => {
  await assertRejectsWithoutWrite(
    {
      organizationId: "org-1",
      propertyId: "property-1",
      messageKind: "AVAILABILITY",
      trigger: "RESERVATION_CREATED",
    },
    /CHANNEX_ARI_INCREMENTAL_SCOPE_REQUIRED/
  );

  await assertRejectsWithoutWrite(
    {
      organizationId: "org-1",
      propertyId: "property-1",
      messageKind: "AVAILABILITY",
      trigger: "RESERVATION_CREATED",
      dateKeys: ["2026-08-01"],
      dateRange: {
        from: "2026-08-01",
        toExclusive: "2026-08-02",
      },
    },
    /CHANNEX_ARI_INCREMENTAL_SCOPE_REQUIRED/
  );
});

test("rejects ranges and sparse exact dates spanning more than 500 days", async () => {
  await assertRejectsWithoutWrite(
    {
      organizationId: "org-1",
      propertyId: "property-1",
      messageKind: "AVAILABILITY",
      trigger: "BLOCKED_DATE_CREATE",
      dateRange: {
        from: "2026-01-01",
        toExclusive: "2027-05-17",
      },
    },
    /CHANNEX_ARI_RANGE_EXCEEDS_HORIZON/
  );

  await assertRejectsWithoutWrite(
    {
      organizationId: "org-1",
      propertyId: "property-1",
      messageKind: "RATES_RESTRICTIONS",
      trigger: "NIGHTLY_RATE_UPDATE",
      dateKeys: ["2026-01-01", "2027-05-17"],
    },
    /CHANNEX_ARI_RANGE_EXCEEDS_HORIZON/
  );
});

test("rejects invalid coalescing values and Full Sync delay", async () => {
  await assertRejectsWithoutWrite(
    {
      organizationId: "org-1",
      propertyId: "property-1",
      messageKind: "AVAILABILITY",
      trigger: "RESERVATION_CREATED",
      dateKeys: ["2026-08-01"],
      coalesceMs: 60_001,
    },
    /CHANNEX_ARI_INVALID_COALESCE_MS/
  );

  await assertRejectsWithoutWrite(
    {
      organizationId: "org-1",
      propertyId: "property-1",
      messageKind: "AVAILABILITY",
      syncMode: "FULL",
      trigger: "MANUAL_RECOVERY",
      correlationId: "full-sync-2",
      todayDateKey: "2026-07-28",
      coalesceMs: 1 as 0,
    },
    /CHANNEX_ARI_FULL_SYNC_CANNOT_COALESCE/
  );
});

test("requires complete source identity and Full Sync correlation", async () => {
  await assertRejectsWithoutWrite(
    {
      organizationId: "org-1",
      propertyId: "property-1",
      messageKind: "AVAILABILITY",
      trigger: "RESERVATION_CREATED",
      sourceEntityType: "RESERVATION",
      dateKeys: ["2026-08-01"],
    },
    /CHANNEX_ARI_SOURCE_IDENTITY_INCOMPLETE/
  );

  await assertRejectsWithoutWrite(
    {
      organizationId: "org-1",
      propertyId: "property-1",
      messageKind: "RATES_RESTRICTIONS",
      syncMode: "FULL",
      trigger: "DISTRIBUTION_ENABLEMENT",
      todayDateKey: "2026-07-28",
    },
    /CHANNEX_ARI_FULL_SYNC_CORRELATION_ID_REQUIRED/
  );
});

test("validates required tenant identity, trigger, message kind and current time", async () => {
  await assertRejectsWithoutWrite(
    {
      organizationId: " ",
      propertyId: "property-1",
      messageKind: "AVAILABILITY",
      trigger: "RESERVATION_CREATED",
      dateKeys: ["2026-08-01"],
    },
    /CHANNEX_ARI_ORGANIZATION_ID_REQUIRED/
  );

  await assertRejectsWithoutWrite(
    {
      organizationId: "org-1",
      propertyId: "property-1",
      messageKind: "UNKNOWN" as any,
      trigger: "RESERVATION_CREATED",
      dateKeys: ["2026-08-01"],
    },
    /CHANNEX_ARI_INVALID_MESSAGE_KIND/
  );

  await assertRejectsWithoutWrite(
    {
      organizationId: "org-1",
      propertyId: "property-1",
      messageKind: "AVAILABILITY",
      trigger: "RESERVATION_CREATED",
      dateKeys: ["2026-08-01"],
      now: new Date("invalid"),
    },
    /CHANNEX_ARI_INVALID_NOW/
  );
});
