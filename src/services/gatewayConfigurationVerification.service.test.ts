import assert from "node:assert/strict";
import test from "node:test";
import { TTLockGatewayStatusError } from "../ttlock/ttlock.gatewayStatus";
import { applyGatewayMonitoringConfiguration } from "./gatewayConfigurationVerification.service";

function fakePrisma() {
  const writes: any[] = [];

  const prisma = {
    lock: {
      findUnique: async () => ({
        id: "lock-1",
        propertyId: "property-1",
        property: {
          id: "property-1",
          organizationId: "org-1",
        },
      }),
    },
    deviceHealth: {
      findUnique: async () => ({
        id: "health-1",
        lockId: "lock-1",
        organizationId: "org-1",
        propertyId: "property-1",
        battery: 90,
        gatewayConnected: false,
        isOnline: false,
        lastSeenAt: new Date("2026-09-14T00:00:00.000Z"),
        lastSyncAt: new Date("2026-09-14T00:00:00.000Z"),
        lastEventAt: null,
        source: "WORKER",
      }),
      upsert: async (args: any) => {
        writes.push(args);
        return args.update;
      },
    },
  };

  return { prisma: prisma as any, writes };
}

const NOW = new Date("2026-09-15T12:00:00.000Z");

test("enabling monitoring verifies immediately and leaves a healthy gateway idle", async () => {
  const { prisma, writes } = fakePrisma();
  let calls = 0;

  const result = await applyGatewayMonitoringConfiguration(prisma, {
    lockId: "lock-1",
    ttlockLockId: 123,
    enabled: true,
    now: NOW,
    fetchGatewayStatus: async () => {
      calls += 1;
      return {
        hasGateway: true,
        isOnline: true,
        gatewayId: 456,
        gatewayRssi: -60,
        providerRequestCount: 2,
        providerResponseAt: NOW,
        raw: { ok: true },
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.state, "CONNECTED");
  assert.equal(result.gatewayConnected, true);
  assert.equal(result.isOnline, true);
  assert.equal(result.providerRequestCount, 2);
  assert.equal(result.nextCheckAt, null);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].update.gatewayConnected, true);
  assert.equal(writes[0].update.isOnline, true);
  assert.equal(writes[0].update.gatewayNextCheckAt, null);
});

test("confirmed missing gateway enters eight-hour revalidation", async () => {
  const { prisma, writes } = fakePrisma();

  const result = await applyGatewayMonitoringConfiguration(prisma, {
    lockId: "lock-1",
    ttlockLockId: 123,
    enabled: true,
    now: NOW,
    fetchGatewayStatus: async () => ({
      hasGateway: false,
      isOnline: false,
      gatewayId: null,
      gatewayRssi: null,
      providerRequestCount: 1,
      providerResponseAt: NOW,
      raw: { list: [] },
    }),
  });

  assert.equal(result.state, "REVALIDATING");
  assert.equal(result.gatewayConnected, false);
  assert.equal(result.isOnline, false);
  assert.equal(
    result.nextCheckAt?.toISOString(),
    "2026-09-15T20:00:00.000Z"
  );
  assert.equal(writes[0].update.gatewayDisconnectedSince.toISOString(), NOW.toISOString());
});

test("provider error clears stale offline booleans instead of treating them as current truth", async () => {
  const { prisma, writes } = fakePrisma();

  const result = await applyGatewayMonitoringConfiguration(prisma, {
    lockId: "lock-1",
    ttlockLockId: 123,
    enabled: true,
    now: NOW,
    fetchGatewayStatus: async () => {
      throw new TTLockGatewayStatusError({
        message: "temporary provider error",
        providerRequestCount: 1,
      });
    },
  });

  assert.equal(result.state, "REVALIDATING");
  assert.equal(result.gatewayConnected, null);
  assert.equal(result.isOnline, null);
  assert.equal(writes[0].update.gatewayConnected, null);
  assert.equal(writes[0].update.isOnline, null);
});

test("disabling monitoring clears stale gateway telemetry without a provider call", async () => {
  const { prisma, writes } = fakePrisma();
  let calls = 0;

  const result = await applyGatewayMonitoringConfiguration(prisma, {
    lockId: "lock-1",
    ttlockLockId: 123,
    enabled: false,
    now: NOW,
    fetchGatewayStatus: async () => {
      calls += 1;
      throw new Error("must not be called");
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.state, "NOT_MONITORED");
  assert.equal(writes[0].update.gatewayConnected, null);
  assert.equal(writes[0].update.isOnline, null);
  assert.equal(writes[0].update.gatewayNextCheckAt, null);
});
