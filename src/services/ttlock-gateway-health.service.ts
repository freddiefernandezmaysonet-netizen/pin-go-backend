import type { PrismaClient } from "@prisma/client";

import { upsertDeviceHealth } from "./deviceHealth.service";

export type TtlockGatewayCallbackState = {
  organizationId: string;
  gatewayId: number;
  isOnline: boolean;
  occurredAt?: Date;
  gatewayMac?: string | null;
  gatewayName?: string | null;
  gatewayVersion?: string | null;
  networkName?: string | null;
};

export async function applyTtlockGatewayCallbackState(
  prisma: PrismaClient,
  input: TtlockGatewayCallbackState
) {
  const occurredAt = input.occurredAt ?? new Date();

  const existing = await prisma.ttlockGateway.findUnique({
    where: {
      organizationId_ttlockGatewayId: {
        organizationId: input.organizationId,
        ttlockGatewayId: input.gatewayId,
      },
    },
    select: {
      id: true,
      isOnline: true,
      lastEventAt: true,
    },
  });

  const stale =
    existing?.lastEventAt &&
    existing.lastEventAt.getTime() > occurredAt.getTime();

  if (stale) {
    return {
      status: "STALE_EVENT" as const,
      gatewayId: input.gatewayId,
      updatedLocks: 0,
      providerRequests: 0,
    };
  }

  const duplicate =
    existing?.isOnline === input.isOnline;

  const gateway = await prisma.ttlockGateway.upsert({
    where: {
      organizationId_ttlockGatewayId: {
        organizationId: input.organizationId,
        ttlockGatewayId: input.gatewayId,
      },
    },
    create: {
      organizationId: input.organizationId,
      ttlockGatewayId: input.gatewayId,
      gatewayMac: input.gatewayMac ?? null,
      gatewayName: input.gatewayName ?? null,
      gatewayVersion: input.gatewayVersion ?? null,
      networkName: input.networkName ?? null,
      isOnline: input.isOnline,
      lastEventAt: occurredAt,
      lastOnlineAt: input.isOnline ? occurredAt : null,
      lastOfflineAt: input.isOnline ? null : occurredAt,
      source: "TTLOCK_CALLBACK",
      rawPayload: {
        gatewayId: input.gatewayId,
        isOnline: input.isOnline,
      },
    },
    update: {
      gatewayMac: input.gatewayMac ?? undefined,
      gatewayName: input.gatewayName ?? undefined,
      gatewayVersion: input.gatewayVersion ?? undefined,
      networkName: input.networkName ?? undefined,
      isOnline: input.isOnline,
      lastEventAt: occurredAt,
      ...(input.isOnline
        ? { lastOnlineAt: occurredAt }
        : { lastOfflineAt: occurredAt }),
      source: "TTLOCK_CALLBACK",
      rawPayload: {
        gatewayId: input.gatewayId,
        isOnline: input.isOnline,
      },
    },
    select: {
      id: true,
      locks: {
        where: { isActive: true },
        select: {
          id: true,
          deviceHealth: {
            select: {
              gatewayConnected: true,
              isOnline: true,
              gatewayDisconnectedSince: true,
            },
          },
        },
      },
    },
  });

  let updatedLocks = 0;

  for (const lock of gateway.locks) {
    if (
      lock.deviceHealth?.gatewayConnected === input.isOnline &&
      lock.deviceHealth?.isOnline === input.isOnline
    ) {
      continue;
    }

    await upsertDeviceHealth(prisma, {
      lockId: lock.id,
      gatewayConnected: input.isOnline,
      isOnline: input.isOnline,
      gatewayDisconnectedSince: input.isOnline
        ? null
        : lock.deviceHealth?.gatewayDisconnectedSince ?? occurredAt,
      gatewayLastError: input.isOnline
        ? null
        : "TTLock gateway offline callback received",
      lastEventAt: occurredAt,
      lastSyncAt: occurredAt,
      source: "TTLOCK_GATEWAY_CALLBACK",
      rawPayload: {
        telemetryType: "GATEWAY_CALLBACK_COMPATIBILITY",
        gatewayId: input.gatewayId,
        isOnline: input.isOnline,
      },
    });

    updatedLocks += 1;
  }

  return {
    status: duplicate
      ? ("DUPLICATE_STATE" as const)
      : ("UPDATED" as const),
    gatewayId: input.gatewayId,
    updatedLocks,
    providerRequests: 0,
  };
}
