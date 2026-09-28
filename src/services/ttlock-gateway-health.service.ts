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
      _count: {
        select: { locks: true },
      },
    },
  });

  if (
    existing?.lastEventAt &&
    existing.lastEventAt.getTime() > occurredAt.getTime()
  ) {
    return {
      status: "STALE_EVENT" as const,
      gatewayId: input.gatewayId,
      mappedLocks: existing._count.locks,
      providerRequests: 0,
    };
  }

  if (existing && existing.isOnline === input.isOnline) {
    return {
      status: "DUPLICATE_STATE" as const,
      gatewayId: input.gatewayId,
      mappedLocks: existing._count.locks,
      providerRequests: 0,
    };
  }

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
        select: { id: true },
      },
      _count: {
        select: { locks: true },
      },
    },
  });

  await Promise.all(
    gateway.locks.map((lock) =>
      upsertDeviceHealth(prisma, {
        lockId: lock.id,
        gatewayConnected: input.isOnline,
        lastEventAt: occurredAt,
        source: "TTLOCK_CALLBACK",
        gatewayLastCheckedAt: occurredAt,
        gatewayProviderResponseAt: occurredAt,
        gatewayLastSuccessfulAt: input.isOnline ? occurredAt : undefined,
        gatewayLastFailedAt: input.isOnline ? undefined : occurredAt,
        gatewayLastError: input.isOnline ? null : "Gateway disconnected",
        gatewayDisconnectedSince: input.isOnline ? null : occurredAt,
        gatewayRawPayload: {
          gatewayId: input.gatewayId,
          isOnline: input.isOnline,
        },
      })
    )
  );

  return {
    status: "UPDATED" as const,
    gatewayId: input.gatewayId,
    mappedLocks: gateway._count.locks,
    providerRequests: 0,
  };
}
