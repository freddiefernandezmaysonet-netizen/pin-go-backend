import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTtlockGatewayCallbackState,
} from "./ttlock-gateway-health.service";
import {
  learnTtlockGatewayMapping,
} from "./ttlock-gateway-mapping.service";

const NOW = new Date("2026-09-27T17:30:00.000Z");

function fakeGatewayPrisma(input?: {
  existingOnline?: boolean | null;
  existingEventAt?: Date | null;
  mappedLocks?: number;
}) {
  const gatewayWrites: any[] = [];

  const prisma = {
    ttlockGateway: {
      findUnique: async () =>
        input?.existingOnline === undefined
          ? null
          : {
              id: "gateway-record-1",
              isOnline: input.existingOnline,
              lastEventAt: input.existingEventAt ?? null,
              _count: {
                locks: input.mappedLocks ?? 2,
              },
            },
      upsert: async (args: any) => {
        gatewayWrites.push(args);
        return {
          _count: {
            locks: input?.mappedLocks ?? 2,
          },
        };
      },
    },
  };

  return {
    prisma: prisma as any,
    gatewayWrites,
  };
}

test("gateway callback updates one canonical gateway row and makes no provider calls", async () => {
  const { prisma, gatewayWrites } = fakeGatewayPrisma({
    mappedLocks: 3,
  });

  const result = await applyTtlockGatewayCallbackState(prisma, {
    organizationId: "org-1",
    gatewayId: 2046625,
    isOnline: false,
    occurredAt: NOW,
  });

  assert.equal(result.status, "UPDATED");
  assert.equal(result.mappedLocks, 3);
  assert.equal(result.providerRequests, 0);
  assert.equal(gatewayWrites.length, 1);
  assert.equal(gatewayWrites[0].create.isOnline, false);
  assert.equal(gatewayWrites[0].create.ttlockGatewayId, 2046625);
});

test("duplicate gateway state performs no write and no provider call", async () => {
  const { prisma, gatewayWrites } = fakeGatewayPrisma({
    existingOnline: false,
    existingEventAt: new Date("2026-09-27T17:20:00.000Z"),
    mappedLocks: 3,
  });

  const result = await applyTtlockGatewayCallbackState(prisma, {
    organizationId: "org-1",
    gatewayId: 2046625,
    isOnline: false,
    occurredAt: NOW,
  });

  assert.equal(result.status, "DUPLICATE_STATE");
  assert.equal(result.mappedLocks, 3);
  assert.equal(result.providerRequests, 0);
  assert.equal(gatewayWrites.length, 0);
});

test("older callback cannot overwrite newer canonical gateway truth", async () => {
  const { prisma, gatewayWrites } = fakeGatewayPrisma({
    existingOnline: true,
    existingEventAt: new Date("2026-09-27T17:40:00.000Z"),
    mappedLocks: 3,
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
});

test("mapping learns gateway-to-lock relation without writing canonical online state", async () => {
  const gatewayWrites: any[] = [];
  const lockWrites: any[] = [];

  const prisma = {
    ttlockGateway: {
      upsert: async (args: any) => {
        gatewayWrites.push(args);
        return { id: "gateway-record-1" };
      },
    },
    lock: {
      update: async (args: any) => {
        lockWrites.push(args);
        return {};
      },
    },
  } as any;

  const result = await learnTtlockGatewayMapping(prisma, {
    organizationId: "org-1",
    lockId: "lock-1",
    gatewayId: 2046625,
    gatewayMac: "AA:BB:CC:DD:EE:FF",
    source: "GATEWAY_CONFIGURATION",
  });

  assert.equal(result.status, "MAPPED");
  assert.equal(result.providerRequests, 0);
  assert.equal(gatewayWrites.length, 1);
  assert.equal(gatewayWrites[0].create.isOnline, null);
  assert.equal(gatewayWrites[0].create.lastEventAt, null);
  assert.equal("isOnline" in gatewayWrites[0].update, false);
  assert.equal("lastEventAt" in gatewayWrites[0].update, false);
  assert.deepEqual(lockWrites[0].data, {
    ttlockGatewayRecordId: "gateway-record-1",
  });
});
