import type { PrismaClient } from "@prisma/client";
import { upsertDeviceHealth } from "./deviceHealth.service";
import {
  TTLockGatewayStatusError,
  ttlockFetchGatewayStatus,
} from "../ttlock/ttlock.gatewayStatus";
import {
  evaluateTtlockLockLinkHealth,
} from "../ttlock/ttlock.lockLinkHealth";
import {
  GATEWAY_FIRST_RETRY_MS,
} from "../workers/deviceHealth.scheduler.policy";
import { recordTtlockGatewayObservation } from "./ttlock-gateway-health.service";

export type GatewayConfigurationVerificationState =
  | "CONNECTED"
  | "REVALIDATING"
  | "NOT_MONITORED";

type GatewayFetcher = typeof ttlockFetchGatewayStatus;

export async function applyGatewayMonitoringConfiguration(
  prisma: PrismaClient,
  input: {
    lockId: string;
    ttlockLockId: number;
    enabled: boolean;
    now?: Date;
    fetchGatewayStatus?: GatewayFetcher;
  }
) {
  const now = input.now ?? new Date();

  if (!input.enabled) {
    await upsertDeviceHealth(prisma, {
      lockId: input.lockId,
      gatewayConnected: null,
      isOnline: null,
      gatewayRssi: null,
      gatewayLastError: null,
      gatewayNextCheckAt: null,
      gatewayDisconnectedSince: null,
      gatewayCheckReservationId: null,
      source: "GATEWAY_CONFIGURATION",
    });

    return {
      state: "NOT_MONITORED" as const,
      gatewayConnected: null,
      isOnline: null,
      nextCheckAt: null,
      providerRequestCount: 0,
      error: null,
    };
  }

  const fetchGatewayStatus =
    input.fetchGatewayStatus ?? ttlockFetchGatewayStatus;

  try {
    const response = await fetchGatewayStatus(input.ttlockLockId);
    const linkHealth = evaluateTtlockLockLinkHealth({
      hasGateway: response.hasGateway,
      gatewayOnline: response.isOnline,
      rssiUpdatedAt: response.gatewayRssiUpdatedAt,
      now,
    });
    const connected =
      response.hasGateway &&
      response.isOnline &&
      linkHealth.state === "LOCK_LINK_FRESH";

    if (response.gatewayId !== null) {
      await recordTtlockGatewayObservation(prisma, {
        organizationId: (
          await prisma.lock.findUniqueOrThrow({
            where: { id: input.lockId },
            select: {
              property: {
                select: {
                  organizationId: true,
                },
              },
            },
          })
        ).property.organizationId,
        lockId: input.lockId,
        ttlockGatewayId: response.gatewayId,
        isOnline: response.isOnline,
        occurredAt: response.providerResponseAt,
        source: "GATEWAY_CONFIGURATION",
        rawPayload: {
          gatewayId: response.gatewayId,
          isOnline: response.isOnline,
          gatewayRssiUpdatedAt:
            response.gatewayRssiUpdatedAt?.toISOString() ?? null,
        },
      });
    }

    if (connected) {
      // Configuration is the one justified immediate verification. Once the
      // gateway is confirmed healthy, do not maintenance-poll it while idle.
      // The worker resumes gateway checks when a reservation enters the next
      // 24-hour readiness window.
      const nextCheckAt = null;

      await upsertDeviceHealth(prisma, {
        lockId: input.lockId,
        gatewayConnected: true,
        isOnline: true,
        gatewayRssi: response.gatewayRssi,
        gatewayLastCheckedAt: now,
        gatewayLastSuccessfulAt: response.providerResponseAt,
        gatewayLastError: null,
        gatewayRawPayload: response.raw,
        gatewayProviderResponseAt: response.providerResponseAt,
        gatewayNextCheckAt: nextCheckAt,
        gatewayDisconnectedSince: null,
        gatewayCheckReservationId: null,
        lastSyncAt: now,
        lastSeenAt: now,
        source: "GATEWAY_CONFIGURATION",
        rawPayload: {
          telemetryType: "GATEWAY_CONFIGURATION_VERIFICATION",
          gatewayId: response.gatewayId,
          isOnline: response.isOnline,
          providerRequestCount: response.providerRequestCount,
        },
      });

      return {
        state: "CONNECTED" as const,
        gatewayConnected: true,
        isOnline: true,
        nextCheckAt,
        providerRequestCount: response.providerRequestCount,
        error: null,
      };
    }

    const nextCheckAt = new Date(
      now.getTime() + GATEWAY_FIRST_RETRY_MS
    );

    const lockLinkStale =
      linkHealth.state === "LOCK_LINK_STALE";
    const lockLinkUnknown =
      linkHealth.state === "LOCK_LINK_UNKNOWN";

    const gatewayConnected = lockLinkStale || lockLinkUnknown
      ? true
      : false;

    const isOnline = lockLinkStale
      ? false
      : lockLinkUnknown
        ? null
        : false;

    const error = lockLinkStale
      ? "TTLock gateway is online but the lock-to-gateway signal is stale"
      : lockLinkUnknown
        ? "TTLock gateway is online but lock-link freshness could not be verified"
        : response.hasGateway
          ? "TTLock gateway is associated but currently offline"
          : "TTLock did not return a gateway association for this lock";

    await upsertDeviceHealth(prisma, {
      lockId: input.lockId,
      gatewayConnected,
      isOnline,
      gatewayRssi: response.gatewayRssi,
      gatewayLastCheckedAt: now,
      gatewayLastFailedAt: now,
      gatewayLastError: error,
      gatewayRawPayload: response.raw,
      gatewayProviderResponseAt: response.providerResponseAt,
      gatewayNextCheckAt: nextCheckAt,
      gatewayDisconnectedSince:
        lockLinkStale || lockLinkUnknown ? null : now,
      gatewayCheckReservationId: null,
      lastSyncAt: now,
      source: "GATEWAY_CONFIGURATION",
      rawPayload: {
        telemetryType: "GATEWAY_CONFIGURATION_VERIFICATION",
        failure: true,
        hasGateway: response.hasGateway,
        isOnline: response.isOnline,
        gatewayRssiUpdatedAt:
          response.gatewayRssiUpdatedAt?.toISOString() ?? null,
        lockLinkState: linkHealth.state,
        lockLinkAgeMs: linkHealth.ageMs,
        providerRequestCount: response.providerRequestCount,
      },
    });

    return {
      state: "REVALIDATING" as const,
      gatewayConnected,
      isOnline,
      nextCheckAt,
      providerRequestCount: response.providerRequestCount,
      error,
    };
  } catch (error) {
    const gatewayError =
      error instanceof TTLockGatewayStatusError ? error : null;
    const message =
      gatewayError?.message ??
      (error instanceof Error ? error.message : String(error));
    const nextCheckAt = new Date(
      now.getTime() + GATEWAY_FIRST_RETRY_MS
    );

    // A transport/provider failure is not proof that the gateway is offline.
    // Clear stale booleans and enter revalidation instead of presenting an old
    // disconnected value as current truth.
    await upsertDeviceHealth(prisma, {
      lockId: input.lockId,
      gatewayConnected: null,
      isOnline: null,
      gatewayLastCheckedAt: now,
      gatewayLastFailedAt: now,
      gatewayLastError: message,
      gatewayRawPayload: gatewayError?.rawPayload ?? undefined,
      gatewayNextCheckAt: nextCheckAt,
      gatewayDisconnectedSince: now,
      gatewayCheckReservationId: null,
      lastSyncAt: now,
      source: "GATEWAY_CONFIGURATION",
      rawPayload: {
        telemetryType: "GATEWAY_CONFIGURATION_VERIFICATION",
        failure: true,
        providerError: true,
        providerRequestCount: gatewayError?.providerRequestCount ?? 0,
      },
    });

    return {
      state: "REVALIDATING" as const,
      gatewayConnected: null,
      isOnline: null,
      nextCheckAt,
      providerRequestCount: gatewayError?.providerRequestCount ?? 0,
      error: message,
    };
  }
}
