import assert from "node:assert/strict";
import test from "node:test";

import {
  recordTtlockGatewayObservation,
} from "./ttlock-gateway-health.service";

function fakePrisma() {
  const upserts: any[] = [];
  const lockUpdates: any[] = [];

  const prisma = {
    tTLockGateway: {
      upsert: async (args: any) => {
        upserts.push(args);
        return {
          id: "gateway-row-1",
          organizationId: "org-1",
          ttlockGatewayId: 2046625,
          isOnline:
            args.create.isOnline,
        };
      },
    },
    lock: {
      updateMany: async (args: any) => {
        lockUpdates.push(args);
        return { count: 1 };
      },
    },
  } as any;

  return {
    prisma,
    upserts,
    lockUpdates,
  };
}

test("authoritative gateway observation writes shared online state", async () => {
  const {
    prisma,
    upserts,
  } = fakePrisma();

  await recordTtlockGatewayObservation(
    prisma,
    {
      organizationId: "org-1",
      ttlockGatewayId: 2046625,
      isOnline: false,
      source: "TTLOCK_CALLBACK",
      occurredAt: new Date(
        "2026-09-27T16:16:25.584Z"
      ),
    }
  );

  assert.equal(
    upserts.length,
    1
  );
  assert.equal(
    upserts[0].update.isOnline,
    false
  );
  assert.equal(
    upserts[0].update.source,
    "TTLOCK_CALLBACK"
  );
});

test("initial-only worker observation can create mapping but cannot overwrite existing shared state", async () => {
  const {
    prisma,
    upserts,
    lockUpdates,
  } = fakePrisma();

  await recordTtlockGatewayObservation(
    prisma,
    {
      organizationId: "org-1",
      lockId: "lock-1",
      ttlockGatewayId: 2046625,
      isOnline: true,
      source:
        "DEVICE_HEALTH_WORKER",
      stateWriteMode:
        "INITIAL_ONLY",
      occurredAt: new Date(
        "2026-09-27T17:00:00.000Z"
      ),
      rawPayload: {
        isOnline: true,
      },
    }
  );

  assert.equal(
    upserts.length,
    1
  );

  assert.deepEqual(
    upserts[0].update,
    {
      gatewayMac: undefined,
      gatewayName: undefined,
    }
  );

  assert.equal(
    "isOnline" in
      upserts[0].update,
    false
  );
  assert.equal(
    "lastEventAt" in
      upserts[0].update,
    false
  );
  assert.equal(
    "source" in
      upserts[0].update,
    false
  );

  assert.equal(
    upserts[0].create.isOnline,
    true
  );
  assert.equal(
    lockUpdates.length,
    1
  );
});
