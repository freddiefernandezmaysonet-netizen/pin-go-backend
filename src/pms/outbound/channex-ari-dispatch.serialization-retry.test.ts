import assert from "node:assert/strict";
import test from "node:test";

import { claimChannexAriDelivery } from "./channex-ari-dispatch.service";

const NOW = new Date("2026-08-22T00:51:48.736Z");

function readyDelivery() {
  return {
    id: "delivery-1",
    organizationId: "org-1",
    propertyId: "property-1",
    connectionId: "connection-1",
    listingId: "listing-1",
    messageKind: "AVAILABILITY" as const,
    status: "READY" as const,
    payload: { values: [{ availability: 1 }] },
    payloadHash: "hash-1",
    payloadValueCount: 1,
    payloadBytes: 64,
    attemptCount: 0,
    nextAttemptAt: NOW,
    leaseToken: null,
    leaseExpiresAt: null,
  };
}

function createTransactionClient() {
  const delivery = readyDelivery();

  return {
    channexAriDelivery: {
      findUnique: async () => ({ ...delivery }),
      updateMany: async () => ({ count: 1 }),
    },
    channexAriDeliveryAttempt: {
      create: async (args: any) => ({
        id: "attempt-1",
        completedAt: null,
        ...args.data,
      }),
    },
    channexAriPropertyState: {
      findUnique: async () => null,
      upsert: async (args: any) => ({
        propertyId: "property-1",
        organizationId: "org-1",
        pausedUntil: null,
        availabilityNextAllowedAt: null,
        ratesNextAllowedAt: null,
        ...args.create,
        ...args.update,
      }),
    },
  };
}

function prismaSerializationConflict(message = "Transaction failed due to a write conflict or a deadlock. Please retry your transaction") {
  return Object.assign(new Error(message), { code: "P2034" });
}

test("retries a Prisma P2034 claim conflict and succeeds on the next serializable transaction", async () => {
  const tx = createTransactionClient();
  let transactionCalls = 0;

  const db = {
    $transaction: async (callback: (client: any) => Promise<any>) => {
      transactionCalls += 1;

      if (transactionCalls === 1) {
        throw prismaSerializationConflict();
      }

      return callback(tx);
    },
  };

  const result = await claimChannexAriDelivery(db as any, {
    deliveryId: "delivery-1",
    leaseToken: "lease-winner",
    now: NOW,
    leaseMs: 120000,
  });

  assert.equal(transactionCalls, 2);
  assert.equal(result.delivery.status, "PROCESSING");
  assert.equal(result.delivery.attemptCount, 1);
  assert.equal(result.delivery.leaseToken, "lease-winner");
});

test("recognizes the observed write-conflict message even when Prisma code metadata is unavailable", async () => {
  const tx = createTransactionClient();
  let transactionCalls = 0;

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
  };

  const result = await claimChannexAriDelivery(db as any, {
    deliveryId: "delivery-1",
    leaseToken: "lease-message-fallback",
    now: NOW,
  });

  assert.equal(transactionCalls, 2);
  assert.equal(result.delivery.status, "PROCESSING");
});

test("bounds repeated serialization conflicts and emits a stable domain error", async () => {
  let transactionCalls = 0;

  const db = {
    $transaction: async () => {
      transactionCalls += 1;
      throw prismaSerializationConflict();
    },
  };

  await assert.rejects(
    () =>
      claimChannexAriDelivery(db as any, {
        deliveryId: "delivery-1",
        leaseToken: "lease-exhausted",
        now: NOW,
      }),
    /CHANNEX_ARI_DISPATCH_SERIALIZATION_RETRY_EXHAUSTED/
  );

  assert.equal(transactionCalls, 3);
});

test("does not retry non-serialization claim failures", async () => {
  let transactionCalls = 0;

  const db = {
    $transaction: async () => {
      transactionCalls += 1;
      throw new Error("CHANNEX_ARI_DISPATCH_CLAIM_RACE");
    },
  };

  await assert.rejects(
    () =>
      claimChannexAriDelivery(db as any, {
        deliveryId: "delivery-1",
        leaseToken: "lease-no-retry",
        now: NOW,
      }),
    /CHANNEX_ARI_DISPATCH_CLAIM_RACE/
  );

  assert.equal(transactionCalls, 1);
});
