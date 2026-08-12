import assert from "node:assert/strict";
import test from "node:test";

import { createFencedChannexAriDelivery } from "./channex-ari-fenced-delivery.service";

const MATERIALIZED_AT = new Date("2026-07-29T16:00:00.000Z");
const CLAIM_EXPIRES_AT = new Date("2026-07-29T16:02:00.000Z");
const CLAIM_TOKEN = "claim-token-1";

function deliveryInput(eventIds = ["event-1", "event-2"]) {
  return {
    plan: {
      organizationId: "org-1",
      propertyId: "property-1",
      provider: "CHANNEX",
      messageKind: "AVAILABILITY",
      syncMode: "INCREMENTAL",
      scope: "EXACT_DATES",
      dateFrom: "2026-08-01",
      dateToExclusive: "2026-08-03",
      dateKeys: ["2026-08-01", "2026-08-02"],
      correlationId: null,
      correlationIds: [],
      mergedEventIds: eventIds,
      snapshotAt: MATERIALIZED_AT,
    },
    mapping: { marker: "mapping" },
    snapshot: { marker: "snapshot" },
  } as any;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    status: "CLAIMED" as const,
    claimToken: CLAIM_TOKEN,
    claimExpiresAt: CLAIM_EXPIRES_AT,
    deliveryId: null,
    ...overrides,
  };
}

function createDb(input: {
  rows: any[];
  updateCounts?: number[];
}) {
  const updateCounts = [...(input.updateCounts ?? [])];
  const calls = {
    transactions: [] as any[],
    findMany: [] as any[],
    updateMany: [] as any[],
  };
  const tx = {
    distributionOutboxEvent: {
      findMany: async (args: any) => {
        calls.findMany.push(args);
        return input.rows.map((value) => ({ ...value }));
      },
      updateMany: async (args: any) => {
        calls.updateMany.push(args);
        return {
          count:
            updateCounts.length > 0
              ? updateCounts.shift()!
              : input.rows.length,
        };
      },
    },
    channexAriDelivery: {},
  } as any;
  const db = {
    $transaction: async (callback: any, options: any) => {
      calls.transactions.push(options);
      return callback(tx);
    },
  } as any;

  return { db, tx, calls };
}

test("fences a fresh claim, creates the delivery in the same transaction and clears the lease", async () => {
  const mock = createDb({
    rows: [
      row(),
      row({ id: "event-2" }),
    ],
    updateCounts: [2, 2],
  });
  const received: any[] = [];
  const delivery = { id: "delivery-1", status: "READY" };

  const result = await createFencedChannexAriDelivery(mock.db, {
    claimToken: CLAIM_TOKEN,
    materializedAt: MATERIALIZED_AT,
    delivery: deliveryInput(),
    createDelivery: (async (nestedDb: any, input: any) => {
      const nestedTx = await nestedDb.$transaction(async (tx: any) => tx);
      assert.equal(nestedTx, mock.tx);
      received.push(input);
      return {
        delivery,
        reused: false,
        mergedEventCount: 2,
        supersededEventCount: 0,
      } as any;
    }) as any,
  });

  assert.deepEqual(mock.calls.transactions, [
    { isolationLevel: "Serializable" },
  ]);
  assert.equal(mock.calls.findMany.length, 1);
  assert.deepEqual(mock.calls.findMany[0], {
    where: { id: { in: ["event-1", "event-2"] } },
    orderBy: { id: "asc" },
    select: {
      id: true,
      status: true,
      claimToken: true,
      claimExpiresAt: true,
      deliveryId: true,
    },
  });
  assert.equal(mock.calls.updateMany.length, 2);
  assert.deepEqual(mock.calls.updateMany[0], {
    where: {
      id: { in: ["event-1", "event-2"] },
      status: "CLAIMED",
      claimToken: CLAIM_TOKEN,
      claimExpiresAt: { gt: MATERIALIZED_AT },
      deliveryId: null,
    },
    data: { claimToken: CLAIM_TOKEN },
  });
  assert.deepEqual(mock.calls.updateMany[1], {
    where: {
      id: { in: ["event-1", "event-2"] },
      status: "MERGED",
      deliveryId: "delivery-1",
    },
    data: {
      claimedAt: null,
      claimToken: null,
      claimExpiresAt: null,
    },
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].queuedAt.getTime(), MATERIALIZED_AT.getTime());
  assert.deepEqual(result, {
    delivery,
    reused: false,
    mergedEventCount: 2,
    supersededEventCount: 0,
    claimFence: {
      mode: "FRESH",
      eventCount: 2,
      materializedAt: MATERIALIZED_AT,
    },
  });
  assert.equal(JSON.stringify(result).includes(CLAIM_TOKEN), false);
});

test("reuses an already materialized delivery without attempting a fresh claim fence", async () => {
  const mock = createDb({
    rows: [
      row({
        status: "MERGED",
        deliveryId: "delivery-1",
        claimToken: null,
        claimExpiresAt: null,
      }),
      row({
        id: "event-2",
        status: "MERGED",
        deliveryId: "delivery-1",
        claimToken: null,
        claimExpiresAt: null,
      }),
    ],
    updateCounts: [2],
  });

  const result = await createFencedChannexAriDelivery(mock.db, {
    claimToken: CLAIM_TOKEN,
    materializedAt: MATERIALIZED_AT,
    delivery: deliveryInput(),
    createDelivery: (async () => ({
      delivery: { id: "delivery-1" },
      reused: true,
      mergedEventCount: 2,
      supersededEventCount: 0,
    })) as any,
  });

  assert.equal(mock.calls.updateMany.length, 1);
  assert.equal(mock.calls.updateMany[0].data.claimToken, null);
  assert.equal(result.reused, true);
  assert.equal(result.claimFence.mode, "IDEMPOTENT");
});

test("rejects a mismatched or expired claim before creating a delivery", async () => {
  for (const scenario of [
    {
      rows: [row({ claimToken: "other-token" }), row({ id: "event-2" })],
      error: /CHANNEX_ARI_FENCED_DELIVERY_CLAIM_TOKEN_MISMATCH/,
    },
    {
      rows: [
        row({ claimExpiresAt: MATERIALIZED_AT }),
        row({ id: "event-2", claimExpiresAt: MATERIALIZED_AT }),
      ],
      error: /CHANNEX_ARI_FENCED_DELIVERY_CLAIM_EXPIRED/,
    },
    {
      rows: [
        row({ claimExpiresAt: null }),
        row({ id: "event-2", claimExpiresAt: null }),
      ],
      error: /CHANNEX_ARI_FENCED_DELIVERY_CLAIM_EXPIRY_REQUIRED/,
    },
  ]) {
    const mock = createDb({ rows: scenario.rows });
    let createCalls = 0;

    await assert.rejects(
      () =>
        createFencedChannexAriDelivery(mock.db, {
          claimToken: CLAIM_TOKEN,
          materializedAt: MATERIALIZED_AT,
          delivery: deliveryInput(),
          createDelivery: (async () => {
            createCalls += 1;
            return {} as any;
          }) as any,
        }),
      scenario.error
    );
    assert.equal(createCalls, 0);
    assert.equal(mock.calls.updateMany.length, 0);
  }
});

test("rejects missing and mixed outbox state before fencing", async () => {
  const scenarios = [
    {
      rows: [row()],
      error: /CHANNEX_ARI_FENCED_DELIVERY_EVENT_NOT_FOUND/,
    },
    {
      rows: [
        row(),
        row({ id: "event-2", status: "PENDING" }),
      ],
      error: /CHANNEX_ARI_FENCED_DELIVERY_EVENT_STATE_CONFLICT/,
    },
    {
      rows: [
        row({ status: "MERGED", deliveryId: "delivery-1" }),
        row({ id: "event-2" }),
      ],
      error: /CHANNEX_ARI_FENCED_DELIVERY_EVENT_STATE_CONFLICT/,
    },
  ];

  for (const scenario of scenarios) {
    const mock = createDb({ rows: scenario.rows });
    await assert.rejects(
      () =>
        createFencedChannexAriDelivery(mock.db, {
          claimToken: CLAIM_TOKEN,
          materializedAt: MATERIALIZED_AT,
          delivery: deliveryInput(),
          createDelivery: (async () => ({})) as any,
        }),
      scenario.error
    );
    assert.equal(mock.calls.updateMany.length, 0);
  }
});

test("fails closed on claim and finalization CAS races", async () => {
  const claimRace = createDb({
    rows: [row(), row({ id: "event-2" })],
    updateCounts: [1],
  });
  let claimRaceCreateCalls = 0;

  await assert.rejects(
    () =>
      createFencedChannexAriDelivery(claimRace.db, {
        claimToken: CLAIM_TOKEN,
        materializedAt: MATERIALIZED_AT,
        delivery: deliveryInput(),
        createDelivery: (async () => {
          claimRaceCreateCalls += 1;
          return {} as any;
        }) as any,
      }),
    /CHANNEX_ARI_FENCED_DELIVERY_CLAIM_RACE/
  );
  assert.equal(claimRaceCreateCalls, 0);

  const finalizeRace = createDb({
    rows: [row(), row({ id: "event-2" })],
    updateCounts: [2, 1],
  });
  let finalizeRaceCreateCalls = 0;

  await assert.rejects(
    () =>
      createFencedChannexAriDelivery(finalizeRace.db, {
        claimToken: CLAIM_TOKEN,
        materializedAt: MATERIALIZED_AT,
        delivery: deliveryInput(),
        createDelivery: (async () => {
          finalizeRaceCreateCalls += 1;
          return {
            delivery: { id: "delivery-1" },
          } as any;
        }) as any,
      }),
    /CHANNEX_ARI_FENCED_DELIVERY_FINALIZE_RACE/
  );
  assert.equal(finalizeRaceCreateCalls, 1);
});

test("validates claim metadata and event IDs before opening a transaction", async () => {
  const scenarios: Array<{
    input: any;
    error: RegExp;
  }> = [
    {
      input: { claimToken: "", delivery: deliveryInput() },
      error: /CHANNEX_ARI_FENCED_DELIVERY_CLAIM_TOKEN_REQUIRED/,
    },
    {
      input: { claimToken: "bad token", delivery: deliveryInput() },
      error: /CHANNEX_ARI_FENCED_DELIVERY_CLAIM_TOKEN_INVALID/,
    },
    {
      input: {
        claimToken: "x".repeat(129),
        delivery: deliveryInput(),
      },
      error: /CHANNEX_ARI_FENCED_DELIVERY_CLAIM_TOKEN_INVALID/,
    },
    {
      input: {
        claimToken: CLAIM_TOKEN,
        materializedAt: new Date("invalid"),
        delivery: deliveryInput(),
      },
      error: /CHANNEX_ARI_FENCED_DELIVERY_MATERIALIZED_AT_INVALID/,
    },
    {
      input: {
        claimToken: CLAIM_TOKEN,
        delivery: deliveryInput([]),
      },
      error: /CHANNEX_ARI_FENCED_DELIVERY_EVENT_IDS_REQUIRED/,
    },
    {
      input: {
        claimToken: CLAIM_TOKEN,
        delivery: deliveryInput(["event-1", "event-1"]),
      },
      error: /CHANNEX_ARI_FENCED_DELIVERY_EVENT_ID_DUPLICATE/,
    },
    {
      input: {
        claimToken: CLAIM_TOKEN,
        delivery: deliveryInput(["event-1", " "]),
      },
      error: /CHANNEX_ARI_FENCED_DELIVERY_EVENT_ID_INVALID/,
    },
  ];

  for (const scenario of scenarios) {
    const mock = createDb({ rows: [] });
    await assert.rejects(
      () => createFencedChannexAriDelivery(mock.db, scenario.input),
      scenario.error
    );
    assert.equal(mock.calls.transactions.length, 0);
  }
});

test("does not mutate the delivery input", async () => {
  const delivery = deliveryInput();
  const before = structuredClone(delivery);
  const mock = createDb({
    rows: [row(), row({ id: "event-2" })],
    updateCounts: [2, 2],
  });

  await createFencedChannexAriDelivery(mock.db, {
    claimToken: CLAIM_TOKEN,
    materializedAt: MATERIALIZED_AT,
    delivery,
    createDelivery: (async () => ({
      delivery: { id: "delivery-1" },
      reused: false,
    })) as any,
  });

  assert.deepEqual(delivery, before);
});
