import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEX_ARI_MAX_FULL_SUPERSESSION_EVENTS,
  materializeNextChannexAriOutboxBatch,
} from "./channex-ari-outbox-materializer.service";

const STARTED_AT = new Date("2026-07-29T14:00:00.000Z");
const MATERIALIZED_AT = new Date("2026-07-29T14:00:01.000Z");
const FAILED_AT = new Date("2026-07-29T14:00:02.000Z");
const CLAIM_TOKEN = "materializer-claim-1";

function claimedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    organizationId: "org-1",
    propertyId: "property-1",
    provider: "CHANNEX" as const,
    messageKind: "AVAILABILITY" as const,
    syncMode: "INCREMENTAL" as const,
    scope: "EXACT_DATES" as const,
    dateFrom: new Date("2026-08-01T00:00:00.000Z"),
    dateToExclusive: new Date("2026-08-02T00:00:00.000Z"),
    dateKeys: ["2026-08-01"],
    correlationId: null,
    status: "CLAIMED" as const,
    availableAt: new Date("2026-07-29T13:59:00.000Z"),
    materializationAttemptCount: 1,
    claimedAt: STARTED_AT,
    claimToken: CLAIM_TOKEN,
    claimExpiresAt: new Date("2026-07-29T14:02:00.000Z"),
    deliveryId: null,
    createdAt: new Date("2026-07-29T13:58:00.000Z"),
    ...overrides,
  } as any;
}

function incrementalPlan() {
  return {
    organizationId: "org-1",
    propertyId: "property-1",
    provider: "CHANNEX" as const,
    messageKind: "AVAILABILITY" as const,
    syncMode: "INCREMENTAL" as const,
    scope: "EXACT_DATES" as const,
    dateFrom: "2026-08-01",
    dateToExclusive: "2026-08-02",
    dateKeys: ["2026-08-01"],
    correlationId: null,
    correlationIds: [],
    mergedEventIds: ["event-1"],
    snapshotAt: STARTED_AT,
  };
}

function fullPlan() {
  return {
    ...incrementalPlan(),
    syncMode: "FULL" as const,
    scope: "FULL_HORIZON" as const,
    dateFrom: "2026-08-01",
    dateToExclusive: "2027-12-14",
    dateKeys: [],
    correlationId: "full-1",
    correlationIds: ["full-1"],
  };
}

function mapping() {
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

function snapshot() {
  return {
    messageKind: "AVAILABILITY" as const,
    data: {
      dateFrom: "2026-08-01",
      dateToExclusive: "2026-08-02",
      payload: { values: [] },
      payloadHash: "a".repeat(64),
      payloadValueCount: 1,
      payloadBytes: 100,
    },
  } as any;
}

function createClock(...dates: Date[]) {
  let index = 0;

  return () => {
    const value = dates[Math.min(index, dates.length - 1)];
    index += 1;
    return new Date(value);
  };
}

test("recovers stale claims and returns EMPTY when no ready partition exists", async () => {
  const order: string[] = [];
  const recoverCalls: any[] = [];
  const claimCalls: any[] = [];
  const recovery = { recoveredCount: 2, pendingCount: 1, deadCount: 1 };

  const result = await materializeNextChannexAriOutboxBatch({
    db: {} as any,
    now: STARTED_AT,
    claimLeaseMs: 120_000,
    claimLimit: 40,
    recoveryLimit: 20,
    jitterMs: 321,
    claimTokenFactory: () => CLAIM_TOKEN,
    recover: (async (db: any, input: any) => {
      order.push("recover");
      recoverCalls.push({ db, input });
      return recovery as any;
    }) as any,
    claim: (async (db: any, input: any) => {
      order.push("claim");
      claimCalls.push({ db, input });
      return {
        claimToken: null,
        claimedAt: STARTED_AT,
        claimExpiresAt: null,
        events: [],
      } as any;
    }) as any,
  });

  assert.deepEqual(order, ["recover", "claim"]);
  assert.deepEqual(recoverCalls[0].input, {
    now: STARTED_AT,
    limit: 20,
    jitterMs: 321,
  });
  assert.deepEqual(claimCalls[0].input, {
    claimToken: CLAIM_TOKEN,
    now: STARTED_AT,
    leaseMs: 120_000,
    limit: 40,
  });
  assert.deepEqual(result, {
    outcome: "EMPTY",
    startedAt: STARTED_AT,
    recovery,
    claimedCount: 0,
  });
});

test("coalesces a claimed incremental event and creates one fenced delivery", async () => {
  const event = claimedEvent();
  const expectedMapping = mapping();
  const expectedSnapshot = snapshot();
  const order: string[] = [];
  const mappingCalls: any[] = [];
  const snapshotCalls: any[] = [];
  const deliveryCalls: any[] = [];
  const db = {
    distributionOutboxEvent: {
      findMany: async () => {
        throw new Error("SUPERSESSION_QUERY_NOT_EXPECTED");
      },
    },
  } as any;

  const result = await materializeNextChannexAriOutboxBatch({
    db,
    now: STARTED_AT,
    clock: createClock(MATERIALIZED_AT),
    claimTokenFactory: () => CLAIM_TOKEN,
    recover: (async () => {
      order.push("recover");
      return { recoveredCount: 0, pendingCount: 0, deadCount: 0 } as any;
    }) as any,
    claim: (async () => {
      order.push("claim");
      return {
        claimToken: CLAIM_TOKEN,
        claimedAt: STARTED_AT,
        claimExpiresAt: event.claimExpiresAt,
        events: [event],
      } as any;
    }) as any,
    resolveMapping: (async (receivedDb: any, input: any) => {
      order.push("mapping");
      mappingCalls.push({ receivedDb, input });
      return expectedMapping as any;
    }) as any,
    readSnapshot: (async (receivedDb: any, input: any) => {
      order.push("snapshot");
      snapshotCalls.push({ receivedDb, input });
      return expectedSnapshot as any;
    }) as any,
    createDelivery: (async (receivedDb: any, input: any) => {
      order.push("delivery");
      deliveryCalls.push({ receivedDb, input });
      return {
        delivery: { id: "delivery-1" },
        reused: false,
        mergedEventCount: 1,
        supersededEventCount: 0,
        claimFence: {
          mode: "FRESH",
          eventCount: 1,
          materializedAt: MATERIALIZED_AT,
        },
      } as any;
    }) as any,
  });

  assert.deepEqual(order, ["recover", "claim", "mapping", "snapshot", "delivery"]);
  const plan = mappingCalls[0].input;
  assert.deepEqual(plan, {
    organizationId: "org-1",
    propertyId: "property-1",
  });
  assert.equal(snapshotCalls[0].input.plan.snapshotAt.getTime(), STARTED_AT.getTime());
  assert.deepEqual(snapshotCalls[0].input.mapping, expectedMapping);
  assert.deepEqual(deliveryCalls[0].input, {
    claimToken: CLAIM_TOKEN,
    materializedAt: MATERIALIZED_AT,
    delivery: {
      plan: snapshotCalls[0].input.plan,
      mapping: expectedMapping,
      snapshot: expectedSnapshot,
      supersededEventIds: [],
      queuedAt: MATERIALIZED_AT,
    },
  });
  assert.equal(result.outcome, "MATERIALIZED");
  assert.equal(result.claimedCount, 1);
  assert.equal(result.supersededCount, 0);
  assert.equal(result.delivery.delivery.id, "delivery-1");
  assert.equal(JSON.stringify(result).includes(CLAIM_TOKEN), false);
});

test("a FULL plan supersedes only covered, unclaimed incrementals older than the snapshot", async () => {
  const plan = fullPlan();
  const queryCalls: any[] = [];
  const deliveryCalls: any[] = [];
  const db = {
    distributionOutboxEvent: {
      findMany: async (args: any) => {
        queryCalls.push(args);
        return [{ id: "incremental-1" }, { id: "incremental-2" }];
      },
    },
  } as any;

  const result = await materializeNextChannexAriOutboxBatch({
    db,
    now: STARTED_AT,
    clock: createClock(MATERIALIZED_AT),
    claimTokenFactory: () => CLAIM_TOKEN,
    recover: (async () => ({ recoveredCount: 0, pendingCount: 0, deadCount: 0 })) as any,
    claim: (async () => ({
      claimToken: CLAIM_TOKEN,
      claimedAt: STARTED_AT,
      claimExpiresAt: new Date("2026-07-29T14:02:00.000Z"),
      events: [claimedEvent({
        syncMode: "FULL",
        scope: "FULL_HORIZON",
        dateFrom: new Date("2026-08-01T00:00:00.000Z"),
        dateToExclusive: new Date("2027-12-14T00:00:00.000Z"),
        dateKeys: [],
        correlationId: "full-1",
      })],
    })) as any,
    buildPlan: (() => plan) as any,
    resolveMapping: (async () => mapping()) as any,
    readSnapshot: (async () => snapshot()) as any,
    createDelivery: (async (_db: any, input: any) => {
      deliveryCalls.push(input);
      return { delivery: { id: "delivery-full" } } as any;
    }) as any,
  });

  assert.equal(queryCalls.length, 1);
  const where = queryCalls[0].where;
  assert.equal(where.organizationId, "org-1");
  assert.equal(where.propertyId, "property-1");
  assert.equal(where.provider, "CHANNEX");
  assert.equal(where.messageKind, "AVAILABILITY");
  assert.equal(where.syncMode, "INCREMENTAL");
  assert.equal(where.status, "PENDING");
  assert.equal(where.claimToken, null);
  assert.equal(where.deliveryId, null);
  assert.deepEqual(where.createdAt, { lte: STARTED_AT });
  assert.deepEqual(where.dateFrom, { gte: new Date("2026-08-01T00:00:00.000Z") });
  assert.deepEqual(where.dateToExclusive, { lte: new Date("2027-12-14T00:00:00.000Z") });
  assert.equal(queryCalls[0].take, CHANNEX_ARI_MAX_FULL_SUPERSESSION_EVENTS + 1);
  assert.deepEqual(deliveryCalls[0].delivery.supersededEventIds, [
    "incremental-1",
    "incremental-2",
  ]);
  assert.equal(result.outcome, "MATERIALIZED");
  assert.equal(result.supersededCount, 2);
});

test("releases a claimed batch after a safe materialization failure", async () => {
  const failCalls: any[] = [];
  const recovery = { recoveredCount: 0, pendingCount: 0, deadCount: 0 };

  const result = await materializeNextChannexAriOutboxBatch({
    db: {} as any,
    now: STARTED_AT,
    clock: createClock(FAILED_AT),
    jitterMs: 250,
    claimTokenFactory: () => CLAIM_TOKEN,
    recover: (async () => recovery) as any,
    claim: (async () => ({
      claimToken: CLAIM_TOKEN,
      claimedAt: STARTED_AT,
      claimExpiresAt: new Date("2026-07-29T14:02:00.000Z"),
      events: [claimedEvent()],
    })) as any,
    buildPlan: (() => {
      throw new Error("CHANNEX_ARI_COALESCE_FAILED");
    }) as any,
    failClaim: (async (db: any, input: any) => {
      failCalls.push({ db, input });
      return { eventCount: 1, pendingCount: 1, deadCount: 0 } as any;
    }) as any,
  });

  assert.deepEqual(failCalls[0].input, {
    eventIds: ["event-1"],
    claimToken: CLAIM_TOKEN,
    failedAt: FAILED_AT,
    errorCode: "CHANNEX_ARI_COALESCE_FAILED",
    jitterMs: 250,
  });
  assert.deepEqual(result, {
    outcome: "FAILED",
    startedAt: STARTED_AT,
    failedAt: FAILED_AT,
    recovery,
    claimedCount: 1,
    errorCode: "CHANNEX_ARI_COALESCE_FAILED",
    release: {
      released: true,
      eventCount: 1,
      pendingCount: 1,
      deadCount: 0,
    },
  });
});

test("sanitizes unsafe failures and reports a failed claim release without exposing secrets", async () => {
  const result = await materializeNextChannexAriOutboxBatch({
    db: {} as any,
    now: STARTED_AT,
    clock: createClock(FAILED_AT),
    claimTokenFactory: () => CLAIM_TOKEN,
    recover: (async () => ({ recoveredCount: 0, pendingCount: 0, deadCount: 0 })) as any,
    claim: (async () => ({
      claimToken: CLAIM_TOKEN,
      claimedAt: STARTED_AT,
      claimExpiresAt: new Date("2026-07-29T14:02:00.000Z"),
      events: [claimedEvent()],
    })) as any,
    buildPlan: (() => incrementalPlan()) as any,
    resolveMapping: (async () => {
      throw new Error("mapping failed apiKey=super-secret");
    }) as any,
    failClaim: (async () => {
      throw new Error("release failed claimToken=super-secret");
    }) as any,
  });

  assert.equal(result.outcome, "FAILED");
  assert.equal(result.errorCode, "CHANNEX_ARI_OUTBOX_MATERIALIZATION_FAILED");
  assert.deepEqual(result.release, {
    released: false,
    errorCode: "CHANNEX_ARI_OUTBOX_MATERIALIZATION_FAILED",
  });
  assert.equal(JSON.stringify(result).includes("super-secret"), false);
  assert.equal(JSON.stringify(result).includes(CLAIM_TOKEN), false);
});

test("bounds Full Sync supersession and releases the claim when the bound is exceeded", async () => {
  const failCalls: any[] = [];
  const rows = Array.from(
    { length: CHANNEX_ARI_MAX_FULL_SUPERSESSION_EVENTS + 1 },
    (_, index) => ({ id: `incremental-${index}` })
  );
  const db = {
    distributionOutboxEvent: {
      findMany: async () => rows,
    },
  } as any;

  const result = await materializeNextChannexAriOutboxBatch({
    db,
    now: STARTED_AT,
    clock: createClock(FAILED_AT),
    claimTokenFactory: () => CLAIM_TOKEN,
    recover: (async () => ({ recoveredCount: 0, pendingCount: 0, deadCount: 0 })) as any,
    claim: (async () => ({
      claimToken: CLAIM_TOKEN,
      claimedAt: STARTED_AT,
      claimExpiresAt: new Date("2026-07-29T14:02:00.000Z"),
      events: [claimedEvent()],
    })) as any,
    buildPlan: (() => fullPlan()) as any,
    resolveMapping: (async () => mapping()) as any,
    readSnapshot: (async () => snapshot()) as any,
    createDelivery: (async () => {
      throw new Error("DELIVERY_MUST_NOT_RUN");
    }) as any,
    failClaim: (async (_db: any, input: any) => {
      failCalls.push(input);
      return { eventCount: 1, pendingCount: 1, deadCount: 0 } as any;
    }) as any,
  });

  assert.equal(result.outcome, "FAILED");
  assert.equal(result.errorCode, "CHANNEX_ARI_FULL_SUPERSESSION_LIMIT_EXCEEDED");
  assert.equal(failCalls[0].errorCode, "CHANNEX_ARI_FULL_SUPERSESSION_LIMIT_EXCEEDED");
});

test("validates the clock and claim token before touching recovery or claim services", async () => {
  let calls = 0;
  const recover = (async () => {
    calls += 1;
    return {} as any;
  }) as any;

  await assert.rejects(
    () =>
      materializeNextChannexAriOutboxBatch({
        db: {} as any,
        now: new Date("invalid"),
        recover,
      }),
    /CHANNEX_ARI_OUTBOX_MATERIALIZER_NOW_INVALID/
  );
  await assert.rejects(
    () =>
      materializeNextChannexAriOutboxBatch({
        db: {} as any,
        now: STARTED_AT,
        claimTokenFactory: () => "invalid token",
        recover,
      }),
    /CHANNEX_ARI_OUTBOX_MATERIALIZER_CLAIM_TOKEN_INVALID/
  );
  assert.equal(calls, 0);
});

test("propagates recovery or claim failures before any outbox event is owned", async () => {
  let claimCalls = 0;

  await assert.rejects(
    () =>
      materializeNextChannexAriOutboxBatch({
        db: {} as any,
        now: STARTED_AT,
        claimTokenFactory: () => CLAIM_TOKEN,
        recover: (async () => {
          throw new Error("RECOVERY_FAILED");
        }) as any,
        claim: (async () => {
          claimCalls += 1;
          return {} as any;
        }) as any,
      }),
    /RECOVERY_FAILED/
  );
  assert.equal(claimCalls, 0);

  await assert.rejects(
    () =>
      materializeNextChannexAriOutboxBatch({
        db: {} as any,
        now: STARTED_AT,
        claimTokenFactory: () => CLAIM_TOKEN,
        recover: (async () => ({ recoveredCount: 0, pendingCount: 0, deadCount: 0 })) as any,
        claim: (async () => {
          throw new Error("CLAIM_FAILED");
        }) as any,
      }),
    /CLAIM_FAILED/
  );
});
