import assert from "node:assert/strict";
import test from "node:test";

import { addUtcDays } from "./channex-ari-lifecycle.policy";
import { buildChannexAriCoalescingPlan } from "./channex-ari-coalescing.policy";
import { buildChannexAriAvailabilitySnapshot } from "./channex-ari-availability-snapshot.policy";
import { buildChannexAriRatesRestrictionsSnapshot } from "./channex-ari-rates-restrictions-snapshot.policy";
import {
  createChannexAriDelivery,
  type ChannexAriDeliveryMapping,
} from "./channex-ari-delivery.service";

const SNAPSHOT_AT = new Date("2026-07-28T12:00:00.000Z");
const QUEUED_AT = new Date("2026-07-28T12:00:05.000Z");

type MockOutboxRow = {
  id: string;
  organizationId: string;
  propertyId: string;
  provider: "CHANNEX";
  messageKind: "AVAILABILITY" | "RATES_RESTRICTIONS";
  syncMode: "INCREMENTAL" | "FULL";
  status: "PENDING" | "CLAIMED" | "MERGED" | "SUPERSEDED" | "DEAD";
  deliveryId: string | null;
};

type MockDelivery = Record<string, any> & { id: string };

function buildMapping(): ChannexAriDeliveryMapping {
  return {
    connectionId: "connection-1",
    listingId: "listing-1",
    connectionProvider: "CHANNEX",
    connectionOrganizationId: "org-1",
    propertyOrganizationId: "org-1",
    propertyId: "property-1",
    externalRoomTypeId: "room-1",
    channexPropertyId: "channex-property-1",
    channexRatePlanId: "rate-plan-1",
  };
}

function buildExactEvent(input: {
  id: string;
  messageKind?: "AVAILABILITY" | "RATES_RESTRICTIONS";
  dateKeys: string[];
  correlationId?: string | null;
  createdAt?: Date;
}) {
  const dateKeys = [...input.dateKeys].sort();

  return {
    id: input.id,
    organizationId: "org-1",
    propertyId: "property-1",
    provider: "CHANNEX",
    messageKind: input.messageKind ?? "AVAILABILITY",
    syncMode: "INCREMENTAL" as const,
    scope: "EXACT_DATES" as const,
    dateFrom: dateKeys[0],
    dateToExclusive: addUtcDays(dateKeys[dateKeys.length - 1], 1),
    dateKeys,
    correlationId: input.correlationId ?? null,
    availableAt: new Date("2026-07-28T11:59:00.000Z"),
    createdAt: input.createdAt ?? new Date("2026-07-28T11:58:00.000Z"),
  };
}

function buildFullEvent(input: {
  id: string;
  messageKind?: "AVAILABILITY" | "RATES_RESTRICTIONS";
}) {
  return {
    id: input.id,
    organizationId: "org-1",
    propertyId: "property-1",
    provider: "CHANNEX",
    messageKind: input.messageKind ?? "AVAILABILITY",
    syncMode: "FULL" as const,
    scope: "FULL_HORIZON" as const,
    dateFrom: "2026-07-28",
    dateToExclusive: "2027-12-10",
    dateKeys: [],
    correlationId: "full-sync-1",
    availableAt: new Date("2026-07-28T11:59:00.000Z"),
    createdAt: new Date("2026-07-28T11:58:00.000Z"),
  };
}

function buildOutboxRow(input: {
  id: string;
  messageKind?: "AVAILABILITY" | "RATES_RESTRICTIONS";
  syncMode?: "INCREMENTAL" | "FULL";
  status?: MockOutboxRow["status"];
  deliveryId?: string | null;
  propertyId?: string;
  organizationId?: string;
}): MockOutboxRow {
  return {
    id: input.id,
    organizationId: input.organizationId ?? "org-1",
    propertyId: input.propertyId ?? "property-1",
    provider: "CHANNEX",
    messageKind: input.messageKind ?? "AVAILABILITY",
    syncMode: input.syncMode ?? "INCREMENTAL",
    status: input.status ?? "CLAIMED",
    deliveryId: input.deliveryId ?? null,
  };
}

function createMockDb(
  initialRows: MockOutboxRow[],
  options?: {
    forceMergedRace?: boolean;
    forceSupersededRace?: boolean;
  }
) {
  const state = {
    rows: initialRows.map((row) => ({ ...row })),
    deliveries: [] as MockDelivery[],
    deliveryCreateCalls: 0,
    updateManyCalls: 0,
  };

  function matches(row: MockOutboxRow, where: Record<string, any>): boolean {
    if (where.id?.in && !where.id.in.includes(row.id)) return false;

    for (const field of [
      "organizationId",
      "propertyId",
      "provider",
      "messageKind",
      "syncMode",
      "status",
      "deliveryId",
    ]) {
      if (where[field] !== undefined && row[field as keyof MockOutboxRow] !== where[field]) {
        return false;
      }
    }

    return true;
  }

  const tx = {
    distributionOutboxEvent: {
      findMany: async ({ where }: any) =>
        state.rows
          .filter((row) => matches(row, where))
          .map((row) => ({ ...row })),
      updateMany: async ({ where, data }: any) => {
        state.updateManyCalls += 1;

        if (data.status === "MERGED" && options?.forceMergedRace) {
          return { count: 0 };
        }

        if (data.status === "SUPERSEDED" && options?.forceSupersededRace) {
          return { count: 0 };
        }

        let count = 0;

        for (const row of state.rows) {
          if (!matches(row, where)) continue;

          row.status = data.status;
          row.deliveryId = data.deliveryId;
          count += 1;
        }

        return { count };
      },
    },
    channexAriDelivery: {
      create: async ({ data }: any) => {
        state.deliveryCreateCalls += 1;
        const now = new Date("2026-07-28T12:00:05.000Z");
        const delivery: MockDelivery = {
          id: `delivery-${state.deliveryCreateCalls}`,
          ...data,
          createdAt: now,
          updatedAt: now,
        };

        state.deliveries.push(delivery);
        return delivery;
      },
      findUnique: async ({ where }: any) =>
        state.deliveries.find((delivery) => delivery.id === where.id) ?? null,
    },
  };

  return {
    db: {
      $transaction: async (callback: (transaction: any) => Promise<any>) =>
        callback(tx),
    },
    state,
  };
}

test("creates one immutable READY Availability delivery and merges claimed outbox rows", async () => {
  const event1 = buildExactEvent({
    id: "event-1",
    dateKeys: ["2026-08-01", "2026-08-03"],
    correlationId: "reservation-1",
  });
  const event2 = buildExactEvent({
    id: "event-2",
    dateKeys: ["2026-08-02"],
    correlationId: "reservation-2",
    createdAt: new Date("2026-07-28T11:58:01.000Z"),
  });
  const plan = buildChannexAriCoalescingPlan({
    events: [event2, event1],
    snapshotAt: SNAPSHOT_AT,
  });
  const availabilitySnapshot = buildChannexAriAvailabilitySnapshot({
    channexPropertyId: "channex-property-1",
    channexRoomTypeId: "room-1",
    propertyTimezone: "America/Puerto_Rico",
    dateKeys: plan.dateKeys,
    activeReservationRanges: [
      {
        startsAt: new Date("2026-08-01T19:00:00.000Z"),
        endsAt: new Date("2026-08-03T15:00:00.000Z"),
      },
    ],
  });
  const mock = createMockDb([
    buildOutboxRow({ id: "event-1" }),
    buildOutboxRow({ id: "event-2" }),
  ]);

  const result = await createChannexAriDelivery(mock.db as any, {
    plan,
    mapping: buildMapping(),
    snapshot: {
      messageKind: "AVAILABILITY",
      data: availabilitySnapshot,
    },
    queuedAt: QUEUED_AT,
  });

  assert.equal(result.reused, false);
  assert.equal(result.mergedEventCount, 2);
  assert.equal(result.supersededEventCount, 0);
  assert.equal(mock.state.deliveries.length, 1);

  const delivery = mock.state.deliveries[0];
  assert.equal(delivery.status, "READY");
  assert.equal(delivery.messageKind, "AVAILABILITY");
  assert.equal(delivery.syncMode, "INCREMENTAL");
  assert.equal(delivery.scope, "EXACT_DATES");
  assert.deepEqual(delivery.dateKeys, [
    "2026-08-01",
    "2026-08-02",
    "2026-08-03",
  ]);
  assert.equal(delivery.payloadHash, availabilitySnapshot.payloadHash);
  assert.equal(delivery.payloadBytes, availabilitySnapshot.payloadBytes);
  assert.equal(delivery.payloadValueCount, 3);
  assert.equal(delivery.attemptCount, 0);
  assert.deepEqual(delivery.nextAttemptAt, QUEUED_AT);
  assert.deepEqual(delivery.queuedAt, QUEUED_AT);

  assert.deepEqual(
    mock.state.rows.map((row) => ({
      id: row.id,
      status: row.status,
      deliveryId: row.deliveryId,
    })),
    [
      { id: "event-1", status: "MERGED", deliveryId: delivery.id },
      { id: "event-2", status: "MERGED", deliveryId: delivery.id },
    ]
  );
});

test("reuses the same persisted delivery after the caller loses the first response", async () => {
  const event = buildExactEvent({
    id: "event-1",
    dateKeys: ["2026-08-01"],
  });
  const plan = buildChannexAriCoalescingPlan({
    events: [event],
    snapshotAt: SNAPSHOT_AT,
  });
  const snapshot = buildChannexAriAvailabilitySnapshot({
    channexPropertyId: "channex-property-1",
    channexRoomTypeId: "room-1",
    propertyTimezone: "America/Puerto_Rico",
    dateKeys: ["2026-08-01"],
  });
  const mock = createMockDb([buildOutboxRow({ id: "event-1" })]);
  const input = {
    plan,
    mapping: buildMapping(),
    snapshot: {
      messageKind: "AVAILABILITY" as const,
      data: snapshot,
    },
    queuedAt: QUEUED_AT,
  };

  const first = await createChannexAriDelivery(mock.db as any, input);
  const second = await createChannexAriDelivery(mock.db as any, input);

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(first.delivery.id, second.delivery.id);
  assert.equal(mock.state.deliveryCreateCalls, 1);
  assert.equal(mock.state.deliveries.length, 1);
});

test("persists a canonical Rates & Restrictions delivery", async () => {
  const events = [
    buildExactEvent({
      id: "rate-event-1",
      messageKind: "RATES_RESTRICTIONS",
      dateKeys: ["2026-08-01", "2026-08-02"],
      correlationId: "pricing-update-1",
    }),
  ];
  const plan = buildChannexAriCoalescingPlan({
    events,
    snapshotAt: SNAPSHOT_AT,
  });
  const snapshot = buildChannexAriRatesRestrictionsSnapshot({
    channexPropertyId: "channex-property-1",
    channexRatePlanId: "rate-plan-1",
    values: [
      {
        date: "2026-08-01",
        rate: 15999,
        minStayArrival: 2,
        minStayThrough: 2,
        maxStay: 14,
      },
      {
        date: "2026-08-02",
        rate: "175.50",
        minStayArrival: 3,
        minStayThrough: 2,
        maxStay: 0,
      },
    ],
  });
  const mock = createMockDb([
    buildOutboxRow({
      id: "rate-event-1",
      messageKind: "RATES_RESTRICTIONS",
    }),
  ]);

  const result = await createChannexAriDelivery(mock.db as any, {
    plan,
    mapping: buildMapping(),
    snapshot: {
      messageKind: "RATES_RESTRICTIONS",
      data: snapshot,
    },
    queuedAt: QUEUED_AT,
  });

  assert.equal(result.reused, false);
  assert.equal(result.delivery.messageKind, "RATES_RESTRICTIONS");
  assert.equal(result.delivery.payloadHash, snapshot.payloadHash);
  assert.deepEqual(result.delivery.payload, snapshot.payload);
  assert.equal(mock.state.rows[0].status, "MERGED");
});

test("Full Sync merges its claimed intent and supersedes covered pending incrementals", async () => {
  const fullEvent = buildFullEvent({ id: "full-event-1" });
  const plan = buildChannexAriCoalescingPlan({
    events: [fullEvent],
    snapshotAt: SNAPSHOT_AT,
  });
  const dateKeys = Array.from({ length: 500 }, (_, index) =>
    addUtcDays("2026-07-28", index)
  );
  const snapshot = buildChannexAriAvailabilitySnapshot({
    channexPropertyId: "channex-property-1",
    channexRoomTypeId: "room-1",
    propertyTimezone: "America/Puerto_Rico",
    dateKeys,
  });
  const mock = createMockDb([
    buildOutboxRow({
      id: "full-event-1",
      syncMode: "FULL",
      status: "CLAIMED",
    }),
    buildOutboxRow({
      id: "incremental-covered-1",
      syncMode: "INCREMENTAL",
      status: "PENDING",
    }),
  ]);

  const result = await createChannexAriDelivery(mock.db as any, {
    plan,
    mapping: buildMapping(),
    snapshot: {
      messageKind: "AVAILABILITY",
      data: snapshot,
    },
    supersededEventIds: ["incremental-covered-1"],
    queuedAt: QUEUED_AT,
  });

  assert.equal(result.mergedEventCount, 1);
  assert.equal(result.supersededEventCount, 1);
  assert.equal(result.delivery.syncMode, "FULL");
  assert.equal(result.delivery.payloadValueCount, 500);
  assert.deepEqual(
    mock.state.rows.map((row) => ({ id: row.id, status: row.status })),
    [
      { id: "full-event-1", status: "MERGED" },
      { id: "incremental-covered-1", status: "SUPERSEDED" },
    ]
  );
  assert.equal(
    mock.state.rows[0].deliveryId,
    mock.state.rows[1].deliveryId
  );
});

test("rejects fresh delivery creation unless every merged event is CLAIMED", async () => {
  const event = buildExactEvent({
    id: "event-1",
    dateKeys: ["2026-08-01"],
  });
  const plan = buildChannexAriCoalescingPlan({
    events: [event],
    snapshotAt: SNAPSHOT_AT,
  });
  const snapshot = buildChannexAriAvailabilitySnapshot({
    channexPropertyId: "channex-property-1",
    channexRoomTypeId: "room-1",
    propertyTimezone: "America/Puerto_Rico",
    dateKeys: ["2026-08-01"],
  });
  const mock = createMockDb([
    buildOutboxRow({ id: "event-1", status: "PENDING" }),
  ]);

  await assert.rejects(
    () =>
      createChannexAriDelivery(mock.db as any, {
        plan,
        mapping: buildMapping(),
        snapshot: {
          messageKind: "AVAILABILITY",
          data: snapshot,
        },
        queuedAt: QUEUED_AT,
      }),
    /CHANNEX_ARI_DELIVERY_MERGED_EVENT_NOT_CLAIMED/
  );
  assert.equal(mock.state.deliveryCreateCalls, 0);
});

test("rejects payloads that do not match the certified Channex mapping", async () => {
  const event = buildExactEvent({
    id: "event-1",
    dateKeys: ["2026-08-01"],
  });
  const plan = buildChannexAriCoalescingPlan({
    events: [event],
    snapshotAt: SNAPSHOT_AT,
  });
  const validSnapshot = buildChannexAriAvailabilitySnapshot({
    channexPropertyId: "channex-property-1",
    channexRoomTypeId: "room-1",
    propertyTimezone: "America/Puerto_Rico",
    dateKeys: ["2026-08-01"],
  });
  const invalidSnapshot = {
    ...validSnapshot,
    payload: {
      values: validSnapshot.payload.values.map((value) => ({
        ...value,
        room_type_id: "wrong-room",
      })),
    },
  };
  const mock = createMockDb([buildOutboxRow({ id: "event-1" })]);

  await assert.rejects(
    () =>
      createChannexAriDelivery(mock.db as any, {
        plan,
        mapping: buildMapping(),
        snapshot: {
          messageKind: "AVAILABILITY",
          data: invalidSnapshot,
        },
        queuedAt: QUEUED_AT,
      }),
    /CHANNEX_ARI_DELIVERY_AVAILABILITY_0_ROOM_TYPE_MISMATCH/
  );
  assert.equal(mock.state.deliveryCreateCalls, 0);
});

test("rejects partial idempotency instead of creating a second delivery", async () => {
  const events = [
    buildExactEvent({ id: "event-1", dateKeys: ["2026-08-01"] }),
    buildExactEvent({
      id: "event-2",
      dateKeys: ["2026-08-02"],
      createdAt: new Date("2026-07-28T11:58:01.000Z"),
    }),
  ];
  const plan = buildChannexAriCoalescingPlan({
    events,
    snapshotAt: SNAPSHOT_AT,
  });
  const snapshot = buildChannexAriAvailabilitySnapshot({
    channexPropertyId: "channex-property-1",
    channexRoomTypeId: "room-1",
    propertyTimezone: "America/Puerto_Rico",
    dateKeys: plan.dateKeys,
  });
  const mock = createMockDb([
    buildOutboxRow({
      id: "event-1",
      status: "MERGED",
      deliveryId: "delivery-existing",
    }),
    buildOutboxRow({ id: "event-2", status: "CLAIMED" }),
  ]);

  await assert.rejects(
    () =>
      createChannexAriDelivery(mock.db as any, {
        plan,
        mapping: buildMapping(),
        snapshot: {
          messageKind: "AVAILABILITY",
          data: snapshot,
        },
        queuedAt: QUEUED_AT,
      }),
    /CHANNEX_ARI_DELIVERY_PARTIAL_IDEMPOTENCY_CONFLICT/
  );
  assert.equal(mock.state.deliveryCreateCalls, 0);
});

test("detects a database race while linking claimed events", async () => {
  const event = buildExactEvent({
    id: "event-1",
    dateKeys: ["2026-08-01"],
  });
  const plan = buildChannexAriCoalescingPlan({
    events: [event],
    snapshotAt: SNAPSHOT_AT,
  });
  const snapshot = buildChannexAriAvailabilitySnapshot({
    channexPropertyId: "channex-property-1",
    channexRoomTypeId: "room-1",
    propertyTimezone: "America/Puerto_Rico",
    dateKeys: ["2026-08-01"],
  });
  const mock = createMockDb(
    [buildOutboxRow({ id: "event-1" })],
    { forceMergedRace: true }
  );

  await assert.rejects(
    () =>
      createChannexAriDelivery(mock.db as any, {
        plan,
        mapping: buildMapping(),
        snapshot: {
          messageKind: "AVAILABILITY",
          data: snapshot,
        },
        queuedAt: QUEUED_AT,
      }),
    /CHANNEX_ARI_DELIVERY_MERGED_EVENT_RACE/
  );
});
