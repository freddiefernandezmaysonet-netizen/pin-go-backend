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
  batteryLastCheckedAt?: Date | null;
  batteryNextCheckAt?: Date | null;

  gatewayLastCheckedAt?: Date | null;
  gatewayLastSuccessfulAt?: Date | null;
  gatewayNextCheckAt?: Date | null;
  gatewayDisconnectedSince?: Date | null;
  gatewayCheckReservationId?: string | null;

  gatewayCriticalAlertReservationId?: string | null;
  gatewayCriticalAlertStatus?: string | null;
  gatewayCriticalAlertAttemptCount?: number;
  gatewayCriticalAlertLastAttemptAt?: Date | null;
  gatewayCriticalAlertSentAt?: Date | null;
  gatewayCriticalAlertRecipients?: unknown;
  gatewayCriticalAlertLastError?: string | null;
  
  healthOverrideStatus?: DeviceHealthStatus;
  healthOverrideMessage?: string;
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

  const computedHealth = computeDeviceHealth({
    battery,
    gatewayConnected,
    isOnline,
    lastSeenAt,
  });

  const healthStatus =
    input.healthOverrideStatus ?? computedHealth.healthStatus;

  const healthMessage =
    input.healthOverrideMessage ?? computedHealth.healthMessage;

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
      batteryLastCheckedAt:
        input.batteryLastCheckedAt ?? null,
      batteryNextCheckAt:
        input.batteryNextCheckAt ?? null,

      gatewayLastCheckedAt:
        input.gatewayLastCheckedAt ?? null,
      gatewayLastSuccessfulAt:
        input.gatewayLastSuccessfulAt ?? null,
      gatewayNextCheckAt:
        input.gatewayNextCheckAt ?? null,
      gatewayDisconnectedSince:
        input.gatewayDisconnectedSince ?? null,
      gatewayCheckReservationId:
        input.gatewayCheckReservationId ?? null,

      gatewayCriticalAlertReservationId:
        input.gatewayCriticalAlertReservationId ?? null,
      gatewayCriticalAlertStatus:
        input.gatewayCriticalAlertStatus ?? null,
      gatewayCriticalAlertAttemptCount:
        input.gatewayCriticalAlertAttemptCount ?? 0,
      gatewayCriticalAlertLastAttemptAt:
        input.gatewayCriticalAlertLastAttemptAt ?? null,
      gatewayCriticalAlertSentAt:
        input.gatewayCriticalAlertSentAt ?? null,
      gatewayCriticalAlertRecipients:
        input.gatewayCriticalAlertRecipients as any,
      gatewayCriticalAlertLastError:
        input.gatewayCriticalAlertLastError ?? null,

      healthStatus,
      healthMessage,
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
      batteryLastCheckedAt:
        input.batteryLastCheckedAt !== undefined
          ? input.batteryLastCheckedAt
          : undefined,
      batteryNextCheckAt:
        input.batteryNextCheckAt !== undefined
          ? input.batteryNextCheckAt
          : undefined,

      gatewayLastCheckedAt:
        input.gatewayLastCheckedAt !== undefined
          ? input.gatewayLastCheckedAt
          : undefined,
      gatewayLastSuccessfulAt:
        input.gatewayLastSuccessfulAt !== undefined
          ? input.gatewayLastSuccessfulAt
          : undefined,
      gatewayNextCheckAt:
        input.gatewayNextCheckAt !== undefined
          ? input.gatewayNextCheckAt
          : undefined,
      gatewayDisconnectedSince:
        input.gatewayDisconnectedSince !== undefined
          ? input.gatewayDisconnectedSince
          : undefined,
      gatewayCheckReservationId:
        input.gatewayCheckReservationId !== undefined
          ? input.gatewayCheckReservationId
          : undefined,

      gatewayCriticalAlertReservationId:
        input.gatewayCriticalAlertReservationId !== undefined
          ? input.gatewayCriticalAlertReservationId
          : undefined,
      gatewayCriticalAlertStatus:
        input.gatewayCriticalAlertStatus !== undefined
          ? input.gatewayCriticalAlertStatus
          : undefined,
      gatewayCriticalAlertAttemptCount:
        input.gatewayCriticalAlertAttemptCount !== undefined
          ? input.gatewayCriticalAlertAttemptCount
          : undefined,
      gatewayCriticalAlertLastAttemptAt:
        input.gatewayCriticalAlertLastAttemptAt !== undefined
          ? input.gatewayCriticalAlertLastAttemptAt
          : undefined,
      gatewayCriticalAlertSentAt:
        input.gatewayCriticalAlertSentAt !== undefined
          ? input.gatewayCriticalAlertSentAt
          : undefined,
      gatewayCriticalAlertRecipients:
        input.gatewayCriticalAlertRecipients !== undefined
          ? (input.gatewayCriticalAlertRecipients as any)
          : undefined,
      gatewayCriticalAlertLastError:
        input.gatewayCriticalAlertLastError !== undefined
          ? input.gatewayCriticalAlertLastError
          : undefined,
      
      healthStatus,
      healthMessage,
    },
  });
}