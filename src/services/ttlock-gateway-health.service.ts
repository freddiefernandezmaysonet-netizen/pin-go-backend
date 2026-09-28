import type { PrismaClient } from "@prisma/client";
import { upsertDeviceHealth } from "./deviceHealth.service";
import { computeOperationalRisk } from "../domain/computeOperationalRisk";

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
        select: {
          id: true,
          deviceHealth: {
            select: {
              healthStatus: true,
              battery: true,
              isOnline: true,
              lastSeenAt: true,
              nextCheckInAt: true,
              hasActiveAccess: true,
              gatewayLastError: true,
              gatewayNextCheckAt: true,
            },
          },
        },
      },
      _count: {
        select: { locks: true },
      },
    },
  });

  const lockLinkRecoveryDelayMs = 10 * 60 * 1000;

  await Promise.all(
    gateway.locks.map(async (lock) => {
      const health = lock.deviceHealth;
      const hadStaleLockLink =
        input.isOnline &&
        health?.isOnline === false &&
        health?.gatewayLastError?.includes(
          "lock-to-gateway signal has not refreshed"
        );

      await upsertDeviceHealth(prisma, {
        lockId: lock.id,
        gatewayConnected: input.isOnline,
        lastEventAt: occurredAt,
        source: "TTLOCK_CALLBACK",
        gatewayLastCheckedAt: occurredAt,
        gatewayProviderResponseAt: occurredAt,
        // Gateway callbacks prove gateway connectivity, not lock↔gateway
        // reachability. Do not turn an ONLINE callback into a lock-link
        // readiness certification.
        gatewayLastSuccessfulAt:
          input.isOnline && hadStaleLockLink ? undefined :
          input.isOnline ? occurredAt : undefined,
        gatewayLastFailedAt: input.isOnline ? undefined : occurredAt,
        gatewayLastError: input.isOnline ? null : "Gateway disconnected",
        gatewayDisconnectedSince: input.isOnline ? null : occurredAt,
        gatewayNextCheckAt:
          hadStaleLockLink
            ? new Date(occurredAt.getTime() + lockLinkRecoveryDelayMs)
            : undefined,
        gatewayRawPayload: {
          gatewayId: input.gatewayId,
          isOnline: input.isOnline,
        },
      });

      if (!health) return;

      const risk = computeOperationalRisk({
        healthStatus: health.healthStatus,
        battery: health.battery,
        gatewayConnected: input.isOnline,
        lastSeenAt: health.lastSeenAt,
        nextCheckInAt: health.nextCheckInAt,
        hasActiveAccess: health.hasActiveAccess,
      });

      await prisma.deviceHealth.update({
        where: { lockId: lock.id },
        data: {
          operationalRisk: risk.operationalRisk,
          operationalMessage: risk.operationalMessage,
          recommendedAction: risk.recommendedAction,
          riskCalculatedAt: occurredAt,
        },
      });
    })
  );

  return {
    status: "UPDATED" as const,
    gatewayId: input.gatewayId,
    mappedLocks: gateway._count.locks,
    providerRequests: 0,
  };
}
