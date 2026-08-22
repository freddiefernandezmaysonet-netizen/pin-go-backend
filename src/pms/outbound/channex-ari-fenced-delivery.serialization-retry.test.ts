import assert from "node:assert/strict";
import test from "node:test";

import { createFencedChannexAriDelivery } from "./channex-ari-fenced-delivery.service";

const MATERIALIZED_AT = new Date("2026-08-22T01:48:11.821Z");
const CLAIM_EXPIRES_AT = new Date("2026-08-22T01:50:10.821Z");
const CLAIM_TOKEN = "claim-token-serialization";

function deliveryInput() {
  return {
    plan: {
      organizationId: "org-1",
      propertyId: "property-1",
      provider: "CHANNEX",
      messageKind: "AVAILABILITY",
      syncMode: "INCREMENTAL",
      scope: "EXACT_DATES",
      dateFrom: "2028-01-02",
      dateToExclusive: "2028-01-03",
      dateKeys: ["2028-01-02"],
      correlationId: null,
      correlationIds: [],
      mergedEventIds: ["event-1"],
      snapshotAt: MATERIALIZED_AT,
    },
    mapping: { marker: "mapping" },
    snapshot: { marker: "snapshot" },
  } as any;
}

function freshRow() {
  return {
    id: "event-1",
    status: "CLAIMED",
    claimToken: CLAIM_TOKEN,
    claimExpiresAt: CLAIM_EXPIRES_AT,
    deliveryId: null,
  };
}

function mergedRow() {
  return {
    id: "event-1",
    status: "MERGED",
    claimToken: null,
    claimExpiresAt: null,
    deliveryId: "delivery-1",
  };
}

function prismaSerializationConflict() {
  return Object.assign(
    new Error(
      "Transaction failed due to a write conflict or a deadlock. Please retry your transaction"
    ),
    { code: "P2034" }
  );
}

test("retries P2034 and reevaluates the persisted delivery as idempotent", async () => {
  let transactionCalls = 0;
  let createCalls = 0;

  const tx = {
    distributionOutboxEvent: {
      findMany: async () => [mergedRow()],
      updateMany: async () => ({ count: 1 }),
    },
    channexAriDelivery: {},
  } as any;

  const db = {
    $transaction: async (callback: (client: any) => Promise<any>) => {
      transactionCalls += 1;

      if (transactionCalls === 1) {
        throw prismaSerializationConflict();
      }

      return callback(tx);
    },
  } as any;

  const result = await createFencedChannexAriDelivery(db, {
    claimToken: CLAIM_TOKEN,
    materializedAt: MATERIALIZED_AT,
    delivery: deliveryInput(),
    createDelivery: (async () => {
      createCalls += 1;
      return {
        delivery: { id: "delivery-1", status: "READY" },
        reused: true,
        mergedEventCount: 1,
        supersededEventCount: 0,
      } as any;
    }) as any,
  });

  assert.equal(transactionCalls, 2);
  assert.equal(createCalls, 1);
  assert.equal(result.delivery.id, "delivery-1");
  assert.equal(result.reused, true);
  assert.equal(result.claimFence.mode, "IDEMPOTENT");
});

test("recognizes the observed write-conflict message without Prisma code metadata", async () => {
  let transactionCalls = 0;

  const tx = {
    distributionOutboxEvent: {
      findMany: async () => [freshRow()],
      updateMany: async () => ({ count: 1 }),
    },
    channexAriDelivery: {},
  } as any;

  const db = {
    $transaction: async (callback: (client: any) => Promise<any>) => {
      transactionCalls += 1;

      if (transactionCalls === 1) {
        throw new Error(
          "Transaction failed due to a write conflict or a deadlock. Please retry your transaction"
        );
      }

      return callback(tx);
    },
  } as any;

  const result = await createFencedChannexAriDelivery(db, {
    claimToken: CLAIM_TOKEN,
    materializedAt: MATERIALIZED_AT,
    delivery: deliveryInput(),
    createDelivery: (async () => ({
      delivery: { id: "delivery-1", status: "READY" },
      reused: false,
      mergedEventCount: 1,
      supersededEventCount: 0,
    })) as any,
  });

  assert.equal(transactionCalls, 2);
  assert.equal(result.claimFence.mode, "FRESH");
});

test("bounds repeated fenced-delivery serialization conflicts", async () => {
  let transactionCalls = 0;

  const db = {
    $transaction: async () => {
      transactionCalls += 1;
      throw prismaSerializationConflict();
    },
  } as any;

  await assert.rejects(
    () =>
      createFencedChannexAriDelivery(db, {
        claimToken: CLAIM_TOKEN,
        materializedAt: MATERIALIZED_AT,
        delivery: deliveryInput(),
      }),
    /CHANNEX_ARI_FENCED_DELIVERY_SERIALIZATION_RETRY_EXHAUSTED/
  );

  assert.equal(transactionCalls, 3);
});

test("does not retry fenced-delivery domain failures", async () => {
  let transactionCalls = 0;

  const db = {
    $transaction: async () => {
      transactionCalls += 1;
      throw new Error("CHANNEX_ARI_FENCED_DELIVERY_CLAIM_RACE");
    },
  } as any;

  await assert.rejects(
    () =>
      createFencedChannexAriDelivery(db, {
        claimToken: CLAIM_TOKEN,
        materializedAt: MATERIALIZED_AT,
        delivery: deliveryInput(),
      }),
    /CHANNEX_ARI_FENCED_DELIVERY_CLAIM_RACE/
  );

  assert.equal(transactionCalls, 1);
});
