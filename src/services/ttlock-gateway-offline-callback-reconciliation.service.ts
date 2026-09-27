import type { PrismaClient } from "@prisma/client";

import { upsertDeviceHealth } from "./deviceHealth.service";

type JsonRecord = Record<string, unknown>;

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function payloadContainsGatewayId(
  value: unknown,
  gatewayId: number,
  depth = 0
): boolean {
  if (depth > 6 || value === null || value === undefined) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) =>
      payloadContainsGatewayId(item, gatewayId, depth + 1)
    );
  }

  if (typeof value !== "object") {
    return false;
  }

  const record = value as JsonRecord;

  if (finiteNumber(record.gatewayId) === gatewayId) {
    return true;
  }

  return Object.values(record).some((item) =>
    payloadContainsGatewayId(item, gatewayId, depth + 1)
  );
}

export async function reconcileTtlockGatewayOfflineCallback(
  prisma: PrismaClient,
  input: {
    gatewayId: number;
    occurredAt?: Date;
  }
) {
  const now = input.occurredAt ?? new Date();

  const locks = await prisma.lock.findMany({
    where: {
      isActive: true,
      deviceHealth: {
        isNot: null,
      },
    },
    select: {
      id: true,
      ttlockLockId: true,
      deviceHealth: {
        select: {
          rawPayload: true,
          gatewayRawPayload: true,
          gatewayDisconnectedSince: true,
        },
      },
    },
  });

  const matchedLocks = locks.filter((lock) => {
    const health = lock.deviceHealth;
    if (!health) return false;

    return (
      payloadContainsGatewayId(
        health.rawPayload,
        input.gatewayId
      ) ||
      payloadContainsGatewayId(
        health.gatewayRawPayload,
        input.gatewayId
      )
    );
  });

  for (const lock of matchedLocks) {
    await upsertDeviceHealth(prisma, {
      lockId: lock.id,
      gatewayConnected: false,
      isOnline: false,
      gatewayLastCheckedAt: now,
      gatewayLastFailedAt: now,
      gatewayLastError:
        "TTLock gateway offline callback received",
      gatewayDisconnectedSince:
        lock.deviceHealth?.gatewayDisconnectedSince ?? now,
      lastEventAt: now,
      lastSyncAt: now,
      source: "TTLOCK_CALLBACK",
      rawPayload: {
        telemetryType: "GATEWAY_CALLBACK",
        gatewayId: input.gatewayId,
        ttlockLockId: lock.ttlockLockId,
        isOnline: false,
      },
    });
  }

  return {
    status:
      matchedLocks.length > 0
        ? ("UPDATED" as const)
        : ("NO_LOCAL_GATEWAY_MAPPING" as const),
    matchedLocks: matchedLocks.length,
    updatedLocks: matchedLocks.length,
    providerRequests: 0,
  };
}
