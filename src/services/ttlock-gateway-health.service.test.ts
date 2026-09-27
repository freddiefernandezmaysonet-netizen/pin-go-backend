import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTtlockGatewayCallbackState,
} from "./ttlock-gateway-health.service";

function fakePrisma(input?: {
  existingOnline?: boolean | null;
  existingEventAt?: Date | null;
  locks?: Array<{
    id: string;
    gatewayConnected: boolean | null;
    isOnline: boolean | null;
  }>;
}) {
  const healthWrites: any[] = [];
  const gatewayWrites: any[] = [];

  const locks = input?.locks ?? [
    {
      id: "lock-1",
      gatewayConnected: true,
      isOnline: true,
    },
    {
      id: "lock-2",
      gatewayConnected: true,
      isOnline: true,
    },
  ];

  const prisma = {
    ttlockGateway: {
      findUnique: async () =>
        input?.existingOnline === undefined
          ? null
          : {
              id: "gateway-record-1",
              isOnline: input.existingOnline,
              lastEventAt: input.existingEventAt ?? null,
            },
      upsert: async (args: any) => {
        gatewayWrites.push(args);
        return {
          id: "gateway-record-1",
          locks: locks.map((lock) => ({
            id: lock.id,
            deviceHealth: {
              gatewayConnected: lock.gatewayConnected,
              isOnline: lock.isOnline,
              gatewayDisconnectedSince: null,
            },
          })),
        };
      },
    },
    lock: {
      findUnique: async ({ where }: any) => {
        const lock = locks.find((item) => item.id === where.id);
        return lock
          ? {
              id: lock.id,
              propertyId: "property-1",
              property: {
                organizationId: "org-1",
              },
            }
          : null;
      },
    },
    deviceHealth: {
      findUnique: async ({ where }: any) => {
        const lock = locks.find((item) => item.id === where.lockId);
        return lock
          ? {
              id: `health-${lock.id}`,
              lockId: lock.id,
              organizationId: "org-1",
              propertyId: "property-1",
              battery: 90,
              gatewayConnected: lock.gatewayConnected,
              isOnline: lock.isOnline,
              lastSeenAt: null,
              lastSyncAt: null,
              lastEventAt: null,
              source: "WORKER",
            }
          : null;
      },
      upsert: async (args: any) => {
        healthWrites.push(args);
        return args.update;
      },
    },
  };

  return {
    prisma: prisma as any,
    healthWrites,
    gatewayWrites,
  };
}

const NOW = new Date("2026-09-27T17:30:00.000Z");

test("one gateway offline callback fans out to every mapped lock without provider calls", async () => {
  const { prisma, healthWrites } = fakePrisma();

  const result = await applyTtlockGatewayCallbackState(prisma, {
    organizationId: "org-1",
    gatewayId: 2046625,
    isOnline: false,
    occurredAt: NOW,
  });

  assert.equal(result.status, "UPDATED");
  assert.equal(result.updatedLocks, 2);
  assert.equal(result.providerRequests, 0);
  assert.equal(healthWrites.length, 2);
  assert.ok(
    healthWrites.every(
      (write) =>
        write.update.gatewayConnected === false &&
        write.update.isOnline === false
    )
  );
});

test("duplicate gateway state is idempotent and does not rewrite matching locks", async () => {
  const { prisma, healthWrites } = fakePrisma({
    existingOnline: false,
    existingEventAt: new Date("2026-09-27T17:20:00.000Z"),
    locks: [
      {
        id: "lock-1",
        gatewayConnected: false,
        isOnline: false,
      },
    ],
  });

  const result = await applyTtlockGatewayCallbackState(prisma, {
    organizationId: "org-1",
    gatewayId: 2046625,
    isOnline: false,
    occurredAt: NOW,
  });

  assert.equal(result.status, "DUPLICATE_STATE");
  assert.equal(result.updatedLocks, 0);
  assert.equal(result.providerRequests, 0);
  assert.equal(healthWrites.length, 0);
});

test("older callback cannot overwrite newer gateway truth", async () => {
  const { prisma, gatewayWrites, healthWrites } = fakePrisma({
    existingOnline: true,
    existingEventAt: new Date("2026-09-27T17:40:00.000Z"),
  });

  const result = await applyTtlockGatewayCallbackState(prisma, {
    organizationId: "org-1",
    gatewayId: 2046625,
    isOnline: false,
    occurredAt: NOW,
  });

  assert.equal(result.status, "STALE_EVENT");
  assert.equal(result.providerRequests, 0);
  assert.equal(gatewayWrites.length, 0);
  assert.equal(healthWrites.length, 0);
});
