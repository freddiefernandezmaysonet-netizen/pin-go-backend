import assert from "node:assert/strict";
import test from "node:test";

import {
  syncTtlockGatewayInventory,
} from "./ttlock-gateway-inventory-sync.service";

test("gateway inventory sync maps many locks with one gateway-list call and one listLock call per gateway", async () => {
  const requests: string[] = [];
  const gatewayWrites: unknown[] = [];
  const lockWrites: unknown[] = [];

  const prisma = {
    lock: {
      findMany: async () => [
        {
          id: "lock-a",
          ttlockLockId: 101,
        },
        {
          id: "lock-b",
          ttlockLockId: 102,
        },
      ],
      updateMany: async (args: unknown) => {
        lockWrites.push(args);
        return { count: 2 };
      },
    },
    tTLockGateway: {
      upsert: async (args: any) => {
        gatewayWrites.push(args);
        return {
          id: "gateway-row-1",
          organizationId: "org-1",
          ttlockGatewayId: 2046625,
          isOnline: false,
        };
      },
    },
  } as any;

  const result =
    await syncTtlockGatewayInventory(
      prisma,
      {
        organizationId: "org-1",
        accessToken: "test-token",
        now: new Date(
          "2026-09-27T17:20:00.000Z"
        ),
        providerRequest: async ({
          path,
        }) => {
          requests.push(path);

          if (
            path ===
            "/v3/gateway/list"
          ) {
            return {
              list: [
                {
                  gatewayId: 2046625,
                  gatewayMac:
                    "AA:BB:CC:DD:EE:FF",
                  lockNum: 2,
                  isOnline: 0,
                },
              ],
              pageNo: 1,
              pageSize: 100,
              pages: 1,
              total: 1,
            };
          }

          if (
            path ===
            "/v3/gateway/listLock"
          ) {
            return {
              list: [
                {
                  lockId: 101,
                  rssi: -60,
                },
                {
                  lockId: 102,
                  rssi: -70,
                },
              ],
            };
          }

          throw new Error(
            `unexpected path ${path}`
          );
        },
      }
    );

  assert.deepEqual(requests, [
    "/v3/gateway/list",
    "/v3/gateway/listLock",
  ]);
  assert.deepEqual(result, {
    gatewaysDiscovered: 1,
    mappedLocks: 2,
    providerRequestCount: 2,
  });
  assert.equal(
    gatewayWrites.length,
    1
  );
  assert.equal(
    lockWrites.length,
    1
  );
});

test("gateway inventory sync cost scales by gateway count, not lock count", async () => {
  const requests: string[] = [];

  const prisma = {
    lock: {
      findMany: async () =>
        Array.from(
          { length: 10 },
          (_, index) => ({
            id: `lock-${index + 1}`,
            ttlockLockId:
              index + 1,
          })
        ),
      updateMany: async (args: any) => ({
        count:
          args.where.id.in.length,
      }),
    },
    tTLockGateway: {
      upsert: async (args: any) => ({
        id:
          args.create
            .ttlockGatewayId === 1
            ? "gateway-1"
            : "gateway-2",
        ...args.create,
      }),
    },
  } as any;

  const result =
    await syncTtlockGatewayInventory(
      prisma,
      {
        organizationId: "org-1",
        accessToken: "test-token",
        providerRequest: async ({
          path,
          body,
        }) => {
          requests.push(path);

          if (
            path ===
            "/v3/gateway/list"
          ) {
            return {
              list: [
                {
                  gatewayId: 1,
                  isOnline: 1,
                },
                {
                  gatewayId: 2,
                  isOnline: 1,
                },
              ],
              pages: 1,
              total: 2,
            };
          }

          const gatewayId =
            Number(
              body.get("gatewayId")
            );

          return {
            list:
              gatewayId === 1
                ? Array.from(
                    { length: 5 },
                    (_, index) => ({
                      lockId:
                        index + 1,
                    })
                  )
                : Array.from(
                    { length: 5 },
                    (_, index) => ({
                      lockId:
                        index + 6,
                    })
                  ),
          };
        },
      }
    );

  assert.equal(
    requests.filter(
      (path) =>
        path ===
        "/v3/gateway/list"
    ).length,
    1
  );
  assert.equal(
    requests.filter(
      (path) =>
        path ===
        "/v3/gateway/listLock"
    ).length,
    2
  );
  assert.equal(
    result.providerRequestCount,
    3
  );
  assert.equal(
    result.mappedLocks,
    10
  );
});
