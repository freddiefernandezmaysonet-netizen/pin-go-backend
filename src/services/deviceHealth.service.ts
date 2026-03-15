import { PrismaClient, DeviceHealthStatus } from "@prisma/client";

const LOW_BATTERY_THRESHOLD = 30;
const OFFLINE_MINUTES = 24 * 60;

type ComputeHealthInput = {
  battery?: number | null;
  gatewayConnected?: boolean | null;
  isOnline?: boolean | null;
  lastSeenAt?: Date | null;
};

export function computeDeviceHealth(input: ComputeHealthInput): {
  healthStatus: DeviceHealthStatus;
  healthMessage: string;
} {
  const { battery, gatewayConnected, isOnline, lastSeenAt } = input;

  if (!lastSeenAt) {
    return {
      healthStatus: "UNKNOWN",
      healthMessage: "No telemetry yet",
    };
  }

  const ageMinutes = (Date.now() - lastSeenAt.getTime()) / 60000;

  if (battery != null && battery < LOW_BATTERY_THRESHOLD) {
    return {
      healthStatus: "LOW_BATTERY",
      healthMessage: `Battery below ${LOW_BATTERY_THRESHOLD}%`,
    };
  }

  if (isOnline === false || ageMinutes > OFFLINE_MINUTES) {
    return {
      healthStatus: "OFFLINE",
      healthMessage: "No recent activity",
    };
  }

  if (gatewayConnected === false) {
    return {
      healthStatus: "WARNING",
      healthMessage: "Gateway disconnected",
    };
  }

  return {
    healthStatus: "HEALTHY",
    healthMessage: "Device operating normally",
  };
}

type UpsertDeviceHealthInput = {
  lockId: string;
  battery?: number | null;
  gatewayConnected?: boolean | null;
  isOnline?: boolean | null;
  lastSyncAt?: Date | null;
  lastEventAt?: Date | null;
  lastSeenAt?: Date | null;
  source?: string | null;
  rawPayload?: unknown;
};

export async function upsertDeviceHealth(
  prisma: PrismaClient,
  input: UpsertDeviceHealthInput
) {
  const lock = await prisma.lock.findUnique({
    where: { id: input.lockId },
    select: {
      id: true,
      propertyId: true,
      property: {
        select: {
          id: true,
          organizationId: true,
        },
      },
    },
  });

  if (!lock) {
    throw new Error("Lock not found");
  }

  if (!lock.property?.organizationId) {
    throw new Error("Lock is missing property/organization relation");
  }

  const existing = await prisma.deviceHealth.findUnique({
    where: { lockId: input.lockId },
  });

  const battery =
    input.battery !== undefined ? input.battery : existing?.battery ?? null;

  const gatewayConnected =
    input.gatewayConnected !== undefined
      ? input.gatewayConnected
      : existing?.gatewayConnected ?? null;

  const isOnline =
    input.isOnline !== undefined ? input.isOnline : existing?.isOnline ?? null;

  const lastSeenAt =
    input.lastSeenAt ??
    input.lastEventAt ??
    input.lastSyncAt ??
    existing?.lastSeenAt ??
    null;

  const health = computeDeviceHealth({
    battery,
    gatewayConnected,
    isOnline,
    lastSeenAt,
  });

  return prisma.deviceHealth.upsert({
    where: { lockId: input.lockId },

    create: {
      lockId: input.lockId,
      organizationId: lock.property.organizationId,
      propertyId: lock.property.id,

      battery,
      gatewayConnected,
      isOnline,

      lastSyncAt: input.lastSyncAt ?? null,
      lastEventAt: input.lastEventAt ?? null,
      lastSeenAt,

      source: input.source ?? null,
      rawPayload: input.rawPayload as any,

      healthStatus: health.healthStatus,
      healthMessage: health.healthMessage,
    },

    update: {
      battery,
      gatewayConnected,
      isOnline,

      lastSyncAt: input.lastSyncAt ?? existing?.lastSyncAt ?? undefined,
      lastEventAt: input.lastEventAt ?? existing?.lastEventAt ?? undefined,
      lastSeenAt,

      source: input.source ?? existing?.source ?? undefined,
      rawPayload: input.rawPayload as any,

      healthStatus: health.healthStatus,
      healthMessage: health.healthMessage,
    },
  });
}
