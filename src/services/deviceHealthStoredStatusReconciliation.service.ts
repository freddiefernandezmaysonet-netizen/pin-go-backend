import type { DeviceHealthStatus, PrismaClient } from "@prisma/client";

import {
  gatewayMonitoringModeFromPolicy,
  loadGatewayMonitoringPolicies,
} from "./lockGatewayMonitoring.service";

type StoredStatusInput = {
  healthStatus: DeviceHealthStatus;
  healthMessage: string | null;
  gatewayConnected: boolean | null;
  isOnline: boolean | null;
};

type StoredStatusResult = {
  healthStatus: DeviceHealthStatus;
  healthMessage: string | null;
  changed: boolean;
};

/**
 * Repairs only impossible stale HEALTHY states from already-persisted telemetry.
 *
 * This intentionally does not use telemetry age. DeviceHealth monitoring is
 * sparse by design, so age-based recomputation could mark healthy idle locks
 * offline even when no provider check is supposed to occur until T-6.
 */
export function reconcileStoredDeviceHealthStatus(
  input: StoredStatusInput
): StoredStatusResult {
  if (input.healthStatus !== "HEALTHY") {
    return {
      healthStatus: input.healthStatus,
      healthMessage: input.healthMessage,
      changed: false,
    };
  }

  if (input.isOnline === false) {
    return {
      healthStatus: "OFFLINE",
      healthMessage: "No recent activity",
      changed: true,
    };
  }

  if (input.gatewayConnected === false) {
    return {
      healthStatus: "WARNING",
      healthMessage: "Gateway disconnected",
      changed: true,
    };
  }

  return {
    healthStatus: input.healthStatus,
    healthMessage: input.healthMessage,
    changed: false,
  };
}

export async function reconcileStoredDeviceHealthStatuses(
  prisma: PrismaClient
) {
  const locks = await prisma.lock.findMany({
    where: { isActive: true },
    select: {
      id: true,
      deviceHealth: {
        select: {
          healthStatus: true,
          healthMessage: true,
          gatewayConnected: true,
          isOnline: true,
        },
      },
    },
  });

  const policies = await loadGatewayMonitoringPolicies(prisma, {
    lockIds: locks.map((lock) => lock.id),
  });

  let corrected = 0;

  for (const lock of locks) {
    if (!lock.deviceHealth) continue;

    const mode = gatewayMonitoringModeFromPolicy(
      policies.get(lock.id) ?? null
    );

    if (mode !== "ENABLED") continue;

    const next = reconcileStoredDeviceHealthStatus(lock.deviceHealth);
    if (!next.changed) continue;

    await prisma.deviceHealth.update({
      where: { lockId: lock.id },
      data: {
        healthStatus: next.healthStatus,
        healthMessage: next.healthMessage,
      },
    });

    corrected += 1;
  }

  console.log("DeviceHealth stored status reconciliation finished", {
    locksEvaluated: locks.length,
    corrected,
  });

  return { locksEvaluated: locks.length, corrected };
}
