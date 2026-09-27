import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileTtlockGatewayOfflineCallback,
} from "./ttlock-gateway-offline-callback-reconciliation.service";

test("offline callback maps every locally known lock on the shared gateway without provider calls", async () => {
  const gatewayUpserts: unknown[] = [];
  const lockUpdates: unknown[] = [];

  const prisma = {
    tTLockGateway: {
      findMany: async () => [],
      upsert: async (args: unknown) => {
        gatewayUpserts.push(args);
        return {
          id: "gateway-row-1",
          organizationId: "org-1",
          ttlockGatewayId: 2046625,
          isOnline: false,
        };
      },
    },
    lock: {
      findMany: async () => [
        {
          id: "lock-1",
          property: {
            organizationId: "org-1",
          },
          deviceHealth: {
            rawPayload: {
              gatewayId: 2046625,
            },
            gatewayRawPayload: null,
          },
        },
        {
          id: "lock-2",
          property: {
            organizationId: "org-1",
          },
          deviceHealth: {
            rawPayload: null,
            gatewayRawPayload: {
              association: {
                list: [
                  {
                    gatewayId: 2046625,
                  },
                ],
              },
            },
          },
        },
      ],
      updateMany: async (args: unknown) => {
        lockUpdates.push(args);
        return {
          count: 2,
        };
      },
    },
  } as any;

  const result =
    await reconcileTtlockGatewayOfflineCallback(
      prisma,
      {
        gatewayId: 2046625,
        occurredAt: new Date(
          "2026-09-27T16:16:25.584Z"
        ),
      }
    );

  assert.deepEqual(result, {
    status: "UPDATED",
    mappedLocks: 2,
    providerRequests: 0,
  });
  assert.equal(gatewayUpserts.length, 1);
  assert.equal(lockUpdates.length, 1);
});

test("duplicate offline callback does not rewrite canonical gateway state", async () => {
  let gatewayUpsertCalled = false;
  const lockUpdates: unknown[] = [];

  const prisma = {
    tTLockGateway: {
      findMany: async () => [
        {
          id: "gateway-row-1",
          organizationId: "org-1",
          isOnline: false,
        },
      ],
      upsert: async () => {
        gatewayUpsertCalled = true;
        throw new Error(
          "duplicate callback must not rewrite gateway"
        );
      },
    },
    lock: {
      findMany: async () => [
        {
          id: "lock-1",
          property: {
            organizationId: "org-1",
          },
          deviceHealth: {
            rawPayload: {
              gatewayId: 2046625,
            },
            gatewayRawPayload: null,
          },
        },
      ],
      updateMany: async (args: unknown) => {
        lockUpdates.push(args);
        return {
          count: 1,
        };
      },
    },
  } as any;

  const result =
    await reconcileTtlockGatewayOfflineCallback(
      prisma,
      {
        gatewayId: 2046625,
      }
    );

  assert.deepEqual(result, {
    status: "DUPLICATE_STATE",
    mappedLocks: 1,
    providerRequests: 0,
  });
  assert.equal(gatewayUpsertCalled, false);
  assert.equal(lockUpdates.length, 1);
});

test("ambiguous gateway id across organizations fails closed", async () => {
  let locksRead = false;

  const prisma = {
    tTLockGateway: {
      findMany: async () => [
        {
          id: "gateway-row-1",
          organizationId: "org-1",
          isOnline: false,
        },
        {
          id: "gateway-row-2",
          organizationId: "org-2",
          isOnline: false,
        },
      ],
    },
    lock: {
      findMany: async () => {
        locksRead = true;
        return [];
      },
    },
  } as any;

  const result =
    await reconcileTtlockGatewayOfflineCallback(
      prisma,
      {
        gatewayId: 2046625,
      }
    );

  assert.deepEqual(result, {
    status: "AMBIGUOUS_GATEWAY_MAPPING",
    mappedLocks: 0,
    providerRequests: 0,
  });
  assert.equal(locksRead, false);
});
