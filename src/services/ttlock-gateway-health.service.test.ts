import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTtlockGatewayCallbackState,
} from "./ttlock-gateway-health.service";
import {
  learnTtlockGatewayMapping,
  resolveUniqueMappedTtlockGateway,
} from "./ttlock-gateway-mapping.service";

const NOW = new Date("2026-09-27T17:30:00.000Z");

function fakeGatewayPrisma(input?: {
  existingOnline?: boolean | null;
  existingEventAt?: Date | null;
  mappedLocks?: number;
  battery?: number | null;
  healthStatus?: string;
}) {
  const gatewayWrites: any[] = [];
  const deviceHealthWrites: any[] = [];
  const riskWrites: any[] = [];
  const lockIds = Array.from(
    { length: input?.mappedLocks ?? 2 },
    (_, index) => `lock-${index + 1}`
  );

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
          id: "gateway-record-1",
          locks: lockIds.map((id) => ({
            id,
            deviceHealth: {
              healthStatus: input?.healthStatus ?? "HEALTHY",
              battery: input?.battery ?? 80,
              isOnline: true,
              lastSeenAt: NOW,
              nextCheckInAt: null,
              hasActiveAccess: false,
            },
          })),
          _count: {
            locks: input?.mappedLocks ?? 2,
          },
        };
      },
    },
    lock: {
      findUnique: async ({ where }: any) => ({
        id: where.id,
        propertyId: "property-1",
        property: {
          id: "property-1",
          organizationId: "org-1",
        },
      }),
    },
    deviceHealth: {
      findUnique: async () => null,
      upsert: async (args: any) => {
        deviceHealthWrites.push(args);
        return {};
      },
      update: async (args: any) => {
        riskWrites.push(args);
        return {};
      },
    },
  };

  return {
    prisma: prisma as any,
    gatewayWrites,
    deviceHealthWrites,
    riskWrites,
  };
}

test("gateway callback updates one canonical gateway row and makes no provider calls", async () => {
  const { prisma, gatewayWrites, deviceHealthWrites, riskWrites } = fakeGatewayPrisma({
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
  assert.equal(deviceHealthWrites.length, 3);
  assert.equal(riskWrites.length, 3);
  for (const write of deviceHealthWrites) {
    assert.equal(write.create.gatewayConnected, false);
    assert.equal(write.create.source, "TTLOCK_CALLBACK");
    assert.equal(write.create.gatewayDisconnectedSince.getTime(), NOW.getTime());
    assert.equal(write.create.gatewayLastFailedAt.getTime(), NOW.getTime());
    assert.equal(write.create.isOnline, null);
  }
});

test("online callback clears gateway disconnect state for every mapped lock", async () => {
  const { prisma, deviceHealthWrites, riskWrites } = fakeGatewayPrisma({
    existingOnline: false,
    existingEventAt: new Date("2026-09-27T17:20:00.000Z"),
    mappedLocks: 3,
  });

  const result = await applyTtlockGatewayCallbackState(prisma, {
    organizationId: "org-1",
    gatewayId: 2046625,
    isOnline: true,
    occurredAt: NOW,
  });

  assert.equal(result.status, "UPDATED");
  assert.equal(deviceHealthWrites.length, 3);
  for (const write of deviceHealthWrites) {
    assert.equal(write.create.gatewayConnected, true);
    assert.equal(write.create.gatewayDisconnectedSince, null);
    assert.equal(write.create.gatewayLastError, null);
    assert.equal(write.create.gatewayLastSuccessfulAt.getTime(), NOW.getTime());
    assert.equal(write.create.isOnline, null);
  }
  for (const write of riskWrites) {
    assert.equal(write.data.operationalRisk, "HEALTHY");
    assert.equal(write.data.operationalMessage, "Lock is ready for normal operation.");
    assert.equal(write.data.recommendedAction, "No action required.");
    assert.equal(write.data.riskCalculatedAt.getTime(), NOW.getTime());
  }
});

test("online callback preserves a real low-battery warning", async () => {
  const { prisma, riskWrites } = fakeGatewayPrisma({
    existingOnline: false,
    existingEventAt: new Date("2026-09-27T17:20:00.000Z"),
    mappedLocks: 1,
    battery: 25,
  });

  await applyTtlockGatewayCallbackState(prisma, {
    organizationId: "org-1",
    gatewayId: 2046625,
    isOnline: true,
    occurredAt: NOW,
  });

  assert.equal(riskWrites.length, 1);
  assert.equal(riskWrites[0].data.operationalRisk, "WARNING");
  assert.match(riskWrites[0].data.operationalMessage, /Battery below 30%/);
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


test("callback gateway resolution is local, unique, and fail-closed", async () => {
  const resolved = await resolveUniqueMappedTtlockGateway(
    {
      ttlockGateway: {
        findMany: async () => [
          {
            id: "gateway-record-1",
            organizationId: "org-1",
            ttlockGatewayId: 2046625,
          },
        ],
      },
    } as any,
    2046625
  );

  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.gateway?.organizationId, "org-1");
  assert.equal(resolved.providerRequests, 0);

  const unknown = await resolveUniqueMappedTtlockGateway(
    {
      ttlockGateway: {
        findMany: async () => [],
      },
    } as any,
    2046625
  );

  assert.equal(unknown.status, "UNKNOWN_GATEWAY");
  assert.equal(unknown.gateway, null);
  assert.equal(unknown.providerRequests, 0);

  const ambiguous = await resolveUniqueMappedTtlockGateway(
    {
      ttlockGateway: {
        findMany: async () => [
          {
            id: "gateway-record-1",
            organizationId: "org-1",
            ttlockGatewayId: 2046625,
          },
          {
            id: "gateway-record-2",
            organizationId: "org-2",
            ttlockGatewayId: 2046625,
          },
        ],
      },
    } as any,
    2046625
  );

  assert.equal(ambiguous.status, "AMBIGUOUS_GATEWAY");
  assert.equal(ambiguous.gateway, null);
  assert.equal(ambiguous.providerRequests, 0);
});
