import assert from "node:assert/strict";
import test from "node:test";

import {
  claimNextChannexAriOutboxBatch,
  failClaimedChannexAriOutboxBatch,
  recoverStaleChannexAriOutboxClaims,
} from "./channex-ari-outbox-materialization.service";

const NOW = new Date("2026-07-29T14:00:00.000Z");
const AVAILABLE_AT = new Date("2026-07-29T13:59:00.000Z");
const CREATED_AT = new Date("2026-07-29T13:58:00.000Z");
const CLAIM_EXPIRES_AT = new Date("2026-07-29T14:02:00.000Z");
const CLAIM_TOKEN = "claim-token-1";

function event(overrides: Record<string, unknown> = {}) {
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
    status: "PENDING" as const,
    availableAt: AVAILABLE_AT,
    materializationAttemptCount: 0,
    claimedAt: null,
    claimToken: null,
    claimExpiresAt: null,
    deliveryId: null,
    createdAt: CREATED_AT,
    ...overrides,
  } as any;
}

function claimedEvent(overrides: Record<string, unknown> = {}) {
  return event({
    status: "CLAIMED",
    materializationAttemptCount: 1,
    claimedAt: NOW,
    claimToken: CLAIM_TOKEN,
    claimExpiresAt: CLAIM_EXPIRES_AT,
    ...overrides,
  });
}

function createDb(input: {
  findFirstResults?: any[];
  findManyResults?: any[][];
  updateCounts?: number[];
}) {
  const findFirstResults = [...(input.findFirstResults ?? [])];
  const findManyResults = [...(input.findManyResults ?? [])];
  const updateCounts = [...(input.updateCounts ?? [])];
  const calls = {
    transactions: [] as any[],
    findFirst: [] as any[],
    findMany: [] as any[],
    updateMany: [] as any[],
  };
  const tx = {
    distributionOutboxEvent: {
      findFirst: async (args: any) => {
        calls.findFirst.push(args);
        return findFirstResults.length > 0 ? findFirstResults.shift() : null;
      },
      findMany: async (args: any) => {
        calls.findMany.push(args);
        return findManyResults.length > 0 ? findManyResults.shift() : [];
      },
      updateMany: async (args: any) => {
        calls.updateMany.push(args);
        return {
          count: updateCounts.length > 0 ? updateCounts.shift()! : 1,
        };
      },
    },
  };
  const db = {
    $transaction: async (callback: any, options: any) => {
      calls.transactions.push(options);
      return callback(tx);
    },
  } as any;

  return { db, calls };
}

test("returns an empty claim when no ready outbox event exists", async () => {
  const mock = createDb({ findFirstResults: [null, null] });

  const result = await claimNextChannexAriOutboxBatch(mock.db, {
    claimToken: CLAIM_TOKEN,
    now: NOW,
  });

  assert.deepEqual(result, {
    claimToken: null,
    claimedAt: NOW,
    claimExpiresAt: null,
    events: [],
  });
  assert.equal(mock.calls.findFirst.length, 2);
  assert.equal(mock.calls.findMany.length, 0);
  assert.equal(mock.calls.updateMany.length, 0);
  assert.deepEqual(mock.calls.transactions, [
    { isolationLevel: "Serializable" },
  ]);
});

test("prioritizes a FULL partition and claims its correlation batch with one fence", async () => {
  const seed = event({
    id: "full-1",
    syncMode: "FULL",
    scope: "FULL_HORIZON",
    dateFrom: new Date("2026-08-01T00:00:00.000Z"),
    dateToExclusive: new Date("2027-12-14T00:00:00.000Z"),
    dateKeys: [],
    correlationId: "full-correlation-1",
  });
  const second = event({
    ...seed,
    id: "full-2",
    materializationAttemptCount: 2,
    createdAt: new Date(CREATED_AT.getTime() + 1),
  });
  const mock = createDb({
    findFirstResults: [seed],
    findManyResults: [[seed, second]],
    updateCounts: [1, 1],
  });

  const result = await claimNextChannexAriOutboxBatch(mock.db, {
    claimToken: CLAIM_TOKEN,
    now: NOW,
    leaseMs: 120_000,
    limit: 10,
  });

  assert.equal(mock.calls.findFirst.length, 1);
  assert.equal(mock.calls.findFirst[0].where.syncMode, "FULL");
  assert.equal(mock.calls.findMany[0].where.organizationId, "org-1");
  assert.equal(mock.calls.findMany[0].where.propertyId, "property-1");
  assert.equal(mock.calls.findMany[0].where.messageKind, "AVAILABILITY");
  assert.equal(mock.calls.findMany[0].where.syncMode, "FULL");
  assert.equal(
    mock.calls.findMany[0].where.correlationId,
    "full-correlation-1"
  );
  assert.equal(mock.calls.findMany[0].take, 10);
  assert.equal(mock.calls.updateMany.length, 2);
  assert.deepEqual(
    mock.calls.updateMany.map((call) => call.where.id),
    ["full-1", "full-2"]
  );
  assert.deepEqual(
    mock.calls.updateMany.map((call) => call.data.claimToken),
    [CLAIM_TOKEN, CLAIM_TOKEN]
  );
  assert.deepEqual(
    mock.calls.updateMany.map(
      (call) => call.data.materializationAttemptCount
    ),
    [1, 3]
  );
  assert.equal(result.claimToken, CLAIM_TOKEN);
  assert.equal(result.claimExpiresAt.getTime(), CLAIM_EXPIRES_AT.getTime());
  assert.deepEqual(
    result.events.map((claimed: any) => ({
      id: claimed.id,
      status: claimed.status,
      attemptCount: claimed.materializationAttemptCount,
      claimToken: claimed.claimToken,
    })),
    [
      {
        id: "full-1",
        status: "CLAIMED",
        attemptCount: 1,
        claimToken: CLAIM_TOKEN,
      },
      {
        id: "full-2",
        status: "CLAIMED",
        attemptCount: 3,
        claimToken: CLAIM_TOKEN,
      },
    ]
  );
});

test("falls back to an incremental partition without correlation filtering", async () => {
  const seed = event();
  const mock = createDb({
    findFirstResults: [null, seed],
    findManyResults: [[seed]],
  });

  const result = await claimNextChannexAriOutboxBatch(mock.db, {
    claimToken: CLAIM_TOKEN,
    now: NOW,
  });

  assert.deepEqual(
    mock.calls.findFirst.map((call) => call.where.syncMode),
    ["FULL", "INCREMENTAL"]
  );
  assert.equal(mock.calls.findMany[0].where.syncMode, "INCREMENTAL");
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      mock.calls.findMany[0].where,
      "correlationId"
    ),
    false
  );
  assert.equal(result.events.length, 1);
});

test("rolls back selection when the seed disappears or a claim CAS loses", async () => {
  const seed = event();
  const missingSeed = createDb({
    findFirstResults: [null, seed],
    findManyResults: [[event({ id: "other" })]],
  });

  await assert.rejects(
    () =>
      claimNextChannexAriOutboxBatch(missingSeed.db, {
        claimToken: CLAIM_TOKEN,
        now: NOW,
      }),
    /CHANNEX_ARI_OUTBOX_CLAIM_SEED_RACE/
  );
  assert.equal(missingSeed.calls.updateMany.length, 0);

  const casRace = createDb({
    findFirstResults: [null, seed],
    findManyResults: [[seed]],
    updateCounts: [0],
  });
  await assert.rejects(
    () =>
      claimNextChannexAriOutboxBatch(casRace.db, {
        claimToken: CLAIM_TOKEN,
        now: NOW,
      }),
    /CHANNEX_ARI_OUTBOX_CLAIM_RACE/
  );
});

test("validates claim input before opening a transaction", async () => {
  const scenarios: Array<[Record<string, unknown>, RegExp]> = [
    [{ claimToken: "" }, /CHANNEX_ARI_OUTBOX_CLAIM_TOKEN_REQUIRED/],
    [{ claimToken: CLAIM_TOKEN, limit: 0 }, /CHANNEX_ARI_OUTBOX_CLAIM_BATCH_LIMIT_INVALID/],
    [{ claimToken: CLAIM_TOKEN, limit: 501 }, /CHANNEX_ARI_OUTBOX_CLAIM_BATCH_LIMIT_INVALID/],
    [{ claimToken: CLAIM_TOKEN, now: new Date("invalid") }, /CHANNEX_ARI_OUTBOX_CLAIM_NOW_INVALID/],
  ];

  for (const [input, error] of scenarios) {
    const mock = createDb({});
    await assert.rejects(
      () => claimNextChannexAriOutboxBatch(mock.db, input as any),
      error
    );
    assert.equal(mock.calls.transactions.length, 0);
  }
});

test("releases a claimed batch to retry or DEAD using exact CAS fences", async () => {
  const retryEvent = claimedEvent({ id: "event-retry" });
  const deadEvent = claimedEvent({
    id: "event-dead",
    materializationAttemptCount: 8,
  });
  const mock = createDb({
    findManyResults: [[retryEvent, deadEvent]],
    updateCounts: [1, 1],
  });
  const failedAt = new Date("2026-07-29T14:01:00.000Z");

  const result = await failClaimedChannexAriOutboxBatch(mock.db, {
    eventIds: ["event-retry", "event-dead"],
    claimToken: CLAIM_TOKEN,
    failedAt,
    errorCode: "CHANNEX_ARI_SNAPSHOT_FAILED",
    errorSummary: "Snapshot unavailable",
  });

  assert.deepEqual(result, {
    eventCount: 2,
    pendingCount: 1,
    deadCount: 1,
  });
  assert.equal(mock.calls.findMany[0].where.claimToken, CLAIM_TOKEN);
  assert.deepEqual(
    mock.calls.updateMany.map((call) => call.where.claimToken),
    [CLAIM_TOKEN, CLAIM_TOKEN]
  );
  assert.equal(mock.calls.updateMany[0].data.status, "PENDING");
  assert.equal(mock.calls.updateMany[1].data.status, "DEAD");
  assert.equal(
    mock.calls.updateMany[0].data.lastErrorCode,
    "CHANNEX_ARI_SNAPSHOT_FAILED"
  );
});

test("rejects incomplete, duplicate or raced failure claims", async () => {
  for (const eventIds of [[], [""], ["event-1", "event-1"]]) {
    const mock = createDb({});
    await assert.rejects(
      () =>
        failClaimedChannexAriOutboxBatch(mock.db, {
          eventIds,
          claimToken: CLAIM_TOKEN,
          failedAt: NOW,
          errorCode: "SAFE_ERROR",
        }),
      /CHANNEX_ARI_OUTBOX_CLAIM_EVENT_(?:IDS_REQUIRED|ID_INVALID|ID_DUPLICATE)/
    );
    assert.equal(mock.calls.transactions.length, 0);
  }

  const missing = createDb({ findManyResults: [[]] });
  await assert.rejects(
    () =>
      failClaimedChannexAriOutboxBatch(missing.db, {
        eventIds: ["event-1"],
        claimToken: CLAIM_TOKEN,
        failedAt: NOW,
        errorCode: "SAFE_ERROR",
      }),
    /CHANNEX_ARI_OUTBOX_FAILURE_CLAIM_NOT_FOUND/
  );

  const race = createDb({
    findManyResults: [[claimedEvent()]],
    updateCounts: [0],
  });
  await assert.rejects(
    () =>
      failClaimedChannexAriOutboxBatch(race.db, {
        eventIds: ["event-1"],
        claimToken: CLAIM_TOKEN,
        failedAt: new Date("2026-07-29T14:01:00.000Z"),
        errorCode: "SAFE_ERROR",
      }),
    /CHANNEX_ARI_OUTBOX_FAILURE_RACE/
  );
});

test("recovers stale claims and reports pending versus DEAD outcomes", async () => {
  const retryEvent = claimedEvent({
    id: "stale-retry",
    claimExpiresAt: NOW,
  });
  const deadEvent = claimedEvent({
    id: "stale-dead",
    claimExpiresAt: NOW,
    materializationAttemptCount: 8,
  });
  const mock = createDb({
    findManyResults: [[retryEvent, deadEvent]],
    updateCounts: [1, 1],
  });

  const result = await recoverStaleChannexAriOutboxClaims(mock.db, {
    now: NOW,
    limit: 20,
    jitterMs: 100,
  });

  assert.deepEqual(result, {
    recoveredCount: 2,
    pendingCount: 1,
    deadCount: 1,
  });
  assert.equal(mock.calls.findMany[0].where.status, "CLAIMED");
  assert.deepEqual(mock.calls.findMany[0].where.claimExpiresAt, {
    lte: NOW,
  });
  assert.equal(mock.calls.findMany[0].take, 20);
  assert.equal(mock.calls.updateMany[0].data.status, "PENDING");
  assert.equal(mock.calls.updateMany[1].data.status, "DEAD");
});

test("returns an empty stale recovery result and rejects recovery CAS races", async () => {
  const empty = createDb({ findManyResults: [[]] });
  assert.deepEqual(
    await recoverStaleChannexAriOutboxClaims(empty.db, { now: NOW }),
    {
      recoveredCount: 0,
      pendingCount: 0,
      deadCount: 0,
    }
  );

  const race = createDb({
    findManyResults: [[claimedEvent({ claimExpiresAt: NOW })]],
    updateCounts: [0],
  });
  await assert.rejects(
    () => recoverStaleChannexAriOutboxClaims(race.db, { now: NOW }),
    /CHANNEX_ARI_OUTBOX_RECOVERY_RACE/
  );
});
