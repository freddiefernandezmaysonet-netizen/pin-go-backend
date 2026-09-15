import { prisma } from "../lib/prisma";
import { computeOperationalRisk } from "../domain/computeOperationalRisk";
import {
  markGatewayReadinessWaiting,
  resolveGatewayReadinessIssue,
  sendGatewayCriticalHostAlert,
  supersedeGatewayReadinessIssue,
} from "../services/device-health-alert.service";
import {
  markGatewayMaintenanceActionRequired,
  markGatewayMaintenanceWaiting,
  resolveGatewayMaintenanceIssue,
} from "../services/gateway-maintenance-operational.service";
import {
  gatewayMonitoringEnabledForWorker,
  gatewayMonitoringModeFromPolicy,
  loadGatewayMonitoringPolicies,
  type GatewayMonitoringMode,
} from "../services/lockGatewayMonitoring.service";
import { upsertDeviceHealth } from "../services/deviceHealth.service";
import {
  TTLockBatteryError,
  ttlockFetchBattery,
} from "../ttlock/ttlock.deviceBattery";
import {
  TTLockGatewayStatusError,
  ttlockFetchGatewayStatus,
} from "../ttlock/ttlock.gatewayStatus";
import {
  isBatteryCheckDue,
  isGatewayCheckDue,
  nextGatewayFailure,
  nextGatewaySuccessCheckAt,
} from "./deviceHealth.scheduler.policy";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const BATTERY_MONTHLY_INTERVAL_MS = 30 * DAY_MS;
const BATTERY_WEEKLY_INTERVAL_MS = 7 * DAY_MS;
const BATTERY_MONITORING_THRESHOLD = 30;
const BATTERY_CRITICAL_THRESHOLD = 20;
const GATEWAY_WINDOW_MS = 24 * HOUR_MS;

type UpcomingReservation = {
  id: string;
  reservationNumber: string | null;
  propertyId: string;
  checkIn: Date;
};

type WorkerLock = {
  id: string;
  propertyId: string;
  ttlockLockId: number;
  ttlockLockName: string | null;
  locationLabel: string | null;
  property: {
    name: string;
    timezone: string | null;
    organizationId: string;
  };
  deviceHealth: {
    id: string;
    battery: number | null;
    gatewayConnected: boolean | null;
    isOnline: boolean | null;
    lastSeenAt: Date | null;
    batteryLastCheckedAt: Date | null;
    batteryNextCheckAt: Date | null;
    gatewayLastCheckedAt: Date | null;
    gatewayLastSuccessfulAt: Date | null;
    gatewayNextCheckAt: Date | null;
    gatewayDisconnectedSince: Date | null;
    gatewayCheckReservationId: string | null;
  } | null;
};

function getLockDisplayName(lock: WorkerLock) {
  return (
    lock.locationLabel?.trim() ||
    lock.ttlockLockName?.trim() ||
    "Property lock"
  );
}

function batteryFailureNextCheckAt(input: {
  now: Date;
  checkIn?: Date | null;
}) {
  if (!input.checkIn) {
    return new Date(input.now.getTime() + DAY_MS);
  }

  const hoursToCheckIn =
    (input.checkIn.getTime() - input.now.getTime()) /
    HOUR_MS;

  if (hoursToCheckIn > 12) {
    return new Date(input.now.getTime() + 4 * HOUR_MS);
  }

  if (hoursToCheckIn > 6) {
    return new Date(input.now.getTime() + 2 * HOUR_MS);
  }

  return new Date(input.now.getTime() + HOUR_MS);
}

async function closePreviousGatewayWorkflow(input: {
  lock: WorkerLock;
  previousReservationId: string | null;
  currentReservationId: string | null;
  now: Date;
}) {
  if (
    !input.previousReservationId ||
    input.previousReservationId === input.currentReservationId
  ) {
    return;
  }

  const previousReservation =
    await prisma.reservation.findUnique({
      where: { id: input.previousReservationId },
      select: {
        id: true,
        reservationNumber: true,
        status: true,
        checkIn: true,
      },
    });

  if (!previousReservation) return;

  const reason =
    previousReservation.status === "CANCELLED"
      ? "RESERVATION_CANCELLED"
      : previousReservation.checkIn <= input.now
        ? "RESERVATION_ENDED"
        : "RESERVATION_REPLACED";

  await supersedeGatewayReadinessIssue({
    prisma,
    organizationId: input.lock.property.organizationId,
    propertyId: input.lock.propertyId,
    reservationId: previousReservation.id,
    reservationNumber: previousReservation.reservationNumber,
    lockId: input.lock.id,
    lockName: getLockDisplayName(input.lock),
    propertyName: input.lock.property.name,
    reason,
    occurredAt: input.now,
  });
}

async function recordGatewayFailure(input: {
  lock: WorkerLock;
  mode: GatewayMonitoringMode;
  reservation: UpcomingReservation | null;
  now: Date;
  gatewayConnected: boolean | null;
  isOnline: boolean | null;
  gatewayRssi?: number | null;
  error?: string | null;
  rawPayload?: unknown;
  providerResponseAt?: Date | null;
}) {
  const plan = nextGatewayFailure({
    now: input.now,
    disconnectedSince:
      input.lock.deviceHealth?.gatewayDisconnectedSince ?? null,
    checkIn: input.reservation?.checkIn ?? null,
  });

  await upsertDeviceHealth(prisma, {
    lockId: input.lock.id,
    gatewayConnected: input.gatewayConnected,
    isOnline: input.isOnline,
    gatewayRssi: input.gatewayRssi,
    gatewayLastCheckedAt: input.now,
    gatewayLastFailedAt: input.now,
    gatewayLastError: input.error ?? null,
    gatewayRawPayload:
      input.rawPayload !== undefined
        ? input.rawPayload
        : undefined,
    gatewayProviderResponseAt:
      input.providerResponseAt ?? undefined,
    gatewayNextCheckAt: plan.nextCheckAt,
    gatewayDisconnectedSince:
      input.lock.deviceHealth?.gatewayDisconnectedSince ??
      input.now,
    gatewayCheckReservationId:
      input.reservation?.id ?? null,
    lastSyncAt: input.now,
    source: "WORKER",
    rawPayload: {
      telemetryType: "GATEWAY",
      failure: true,
      error: input.error ?? null,
      retryStage: plan.stage,
    },
  });

  if (input.reservation) {
    const hoursToCheckIn =
      (input.reservation.checkIn.getTime() - input.now.getTime()) /
      HOUR_MS;

    if (hoursToCheckIn <= 6) {
      const currentHealth =
        await prisma.deviceHealth.findUniqueOrThrow({
          where: { lockId: input.lock.id },
          select: { id: true },
        });

      return sendGatewayCriticalHostAlert({
        prisma,
        deviceHealthId: currentHealth.id,
        organizationId: input.lock.property.organizationId,
        propertyId: input.lock.propertyId,
        reservationId: input.reservation.id,
        reservationNumber: input.reservation.reservationNumber,
        lockId: input.lock.id,
        lockName: getLockDisplayName(input.lock),
        propertyName: input.lock.property.name,
        propertyTimeZone: input.lock.property.timezone,
        checkIn: input.reservation.checkIn,
        now: input.now,
      });
    }

    await markGatewayReadinessWaiting({
      prisma,
      organizationId: input.lock.property.organizationId,
      propertyId: input.lock.propertyId,
      reservationId: input.reservation.id,
      reservationNumber: input.reservation.reservationNumber,
      lockId: input.lock.id,
      lockName: getLockDisplayName(input.lock),
      propertyName: input.lock.property.name,
      checkIn: input.reservation.checkIn,
      nextCheckAt: plan.nextCheckAt,
      occurredAt: input.now,
    });

    return { sent: false };
  }

  if (input.mode === "ENABLED") {
    if (plan.escalate) {
      await markGatewayMaintenanceActionRequired({
        prisma,
        organizationId: input.lock.property.organizationId,
        propertyId: input.lock.propertyId,
        lockId: input.lock.id,
        lockName: getLockDisplayName(input.lock),
        propertyName: input.lock.property.name,
        nextCheckAt: plan.nextCheckAt,
        occurredAt: input.now,
      });
    } else {
      await markGatewayMaintenanceWaiting({
        prisma,
        organizationId: input.lock.property.organizationId,
        propertyId: input.lock.propertyId,
        lockId: input.lock.id,
        lockName: getLockDisplayName(input.lock),
        propertyName: input.lock.property.name,
        nextCheckAt: plan.nextCheckAt,
        stage: plan.stage,
        occurredAt: input.now,
      });
    }
  }

  return { sent: false };
}

export async function runHardenedDeviceHealthWorker() {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + GATEWAY_WINDOW_MS);

  let gatewayEligible = 0;
  let gatewayDisabled = 0;
  let legacyUnconfigured = 0;
  let batteryDue = 0;
  let batterySkipped = 0;
  let gatewayDue = 0;
  let gatewaySkipped = 0;
  let batteryCalls = 0;
  let gatewayCalls = 0;
  let ttlockRequestsTotal = 0;
  let criticalEmailsSent = 0;

  console.log("DeviceHealth hardened worker starting", {
    startedAt: now.toISOString(),
  });

  const upcomingReservations =
    await prisma.reservation.findMany({
      where: {
        status: "ACTIVE",
        checkIn: {
          gte: now,
          lte: windowEnd,
        },
      },
      select: {
        id: true,
        reservationNumber: true,
        propertyId: true,
        checkIn: true,
      },
      orderBy: { checkIn: "asc" },
    });

  const nextReservationByProperty =
    new Map<string, UpcomingReservation>();

  for (const reservation of upcomingReservations) {
    if (!nextReservationByProperty.has(reservation.propertyId)) {
      nextReservationByProperty.set(
        reservation.propertyId,
        reservation
      );
    }
  }

  const locks = (await prisma.lock.findMany({
    where: { isActive: true },
    select: {
      id: true,
      propertyId: true,
      ttlockLockId: true,
      ttlockLockName: true,
      locationLabel: true,
      property: {
        select: {
          name: true,
          timezone: true,
          organizationId: true,
        },
      },
      deviceHealth: {
        select: {
          id: true,
          battery: true,
          gatewayConnected: true,
          isOnline: true,
          lastSeenAt: true,
          batteryLastCheckedAt: true,
          batteryNextCheckAt: true,
          gatewayLastCheckedAt: true,
          gatewayLastSuccessfulAt: true,
          gatewayNextCheckAt: true,
          gatewayDisconnectedSince: true,
          gatewayCheckReservationId: true,
        },
      },
    },
  })) as WorkerLock[];

  const policies = await loadGatewayMonitoringPolicies(
    prisma,
    { lockIds: locks.map((lock) => lock.id) }
  );

  for (const lock of locks) {
    try {
      const reservation =
        nextReservationByProperty.get(lock.propertyId) ?? null;
      const mode = gatewayMonitoringModeFromPolicy(
        policies.get(lock.id) ?? null
      );

      if (mode === "LEGACY_UNCONFIGURED") {
        legacyUnconfigured += 1;
      }

      await closePreviousGatewayWorkflow({
        lock,
        previousReservationId:
          lock.deviceHealth?.gatewayCheckReservationId ?? null,
        currentReservationId: reservation?.id ?? null,
        now,
      });

      if (!gatewayMonitoringEnabledForWorker(mode)) {
        gatewayDisabled += 1;
        batterySkipped += 1;
        gatewaySkipped += 1;

        if (lock.deviceHealth) {
          await upsertDeviceHealth(prisma, {
            lockId: lock.id,
            gatewayConnected: null,
            isOnline: null,
            gatewayNextCheckAt: null,
            gatewayDisconnectedSince: null,
            gatewayCheckReservationId: null,
            gatewayLastError: null,
          });
        }

        await resolveGatewayMaintenanceIssue({
          prisma,
          organizationId: lock.property.organizationId,
          propertyId: lock.propertyId,
          lockId: lock.id,
          lockName: getLockDisplayName(lock),
          propertyName: lock.property.name,
          occurredAt: now,
        });

        continue;
      }

      gatewayEligible += 1;

      const batteryIsDue = isBatteryCheckDue({
        now,
        health: lock.deviceHealth,
      });

      if (batteryIsDue) {
        batteryDue += 1;
        batteryCalls += 1;
        ttlockRequestsTotal += 1;

        try {
          const response = await ttlockFetchBattery(
            lock.ttlockLockId
          );
          const battery = response.battery;
          const nextInterval =
            battery !== null &&
            battery < BATTERY_MONITORING_THRESHOLD
              ? BATTERY_WEEKLY_INTERVAL_MS
              : BATTERY_MONTHLY_INTERVAL_MS;
          const batteryNextCheckAt = new Date(
            now.getTime() + nextInterval
          );

          await upsertDeviceHealth(prisma, {
            lockId: lock.id,
            battery,
            batteryLastCheckedAt: now,
            batteryLastSuccessfulAt:
              response.providerResponseAt,
            batteryLastError: null,
            batteryRawPayload: response.raw,
            batteryProviderResponseAt:
              response.providerResponseAt,
            batteryNextCheckAt,
            lastSyncAt: now,
            lastSeenAt: now,
            source: "WORKER",
            rawPayload: {
              telemetryType: "BATTERY",
              battery: response.raw,
            },
          });
        } catch (error) {
          const batteryError =
            error instanceof TTLockBatteryError
              ? error.details
              : null;
          const nextCheckAt = batteryFailureNextCheckAt({
            now,
            checkIn: reservation?.checkIn ?? null,
          });

          await upsertDeviceHealth(prisma, {
            lockId: lock.id,
            batteryLastCheckedAt: now,
            batteryLastFailedAt: now,
            batteryLastError:
              batteryError?.message ??
              (error instanceof Error
                ? error.message
                : String(error)),
            batteryRawPayload:
              batteryError?.rawPayload ?? undefined,
            batteryProviderResponseAt:
              batteryError?.providerResponseAt ?? undefined,
            batteryNextCheckAt: nextCheckAt,
            lastSyncAt: now,
            source: "WORKER",
            rawPayload: {
              telemetryType: "BATTERY",
              failed: true,
              nextCheckAt: nextCheckAt.toISOString(),
            },
          });
        }
      } else {
        batterySkipped += 1;
      }

      const gatewayIsDue = isGatewayCheckDue({
        now,
        mode,
        health: lock.deviceHealth,
        checkIn: reservation?.checkIn ?? null,
      });

      if (gatewayIsDue) {
        gatewayDue += 1;
        gatewayCalls += 1;

        try {
          const response = await ttlockFetchGatewayStatus(
            lock.ttlockLockId
          );
          ttlockRequestsTotal += response.providerRequestCount;

          const gatewayAvailable =
            response.hasGateway && response.isOnline;

          if (gatewayAvailable) {
            const nextCheckAt = nextGatewaySuccessCheckAt({
              now,
              mode,
              checkIn: reservation?.checkIn ?? null,
            });

            await upsertDeviceHealth(prisma, {
              lockId: lock.id,
              gatewayConnected: true,
              isOnline: true,
              gatewayRssi: response.gatewayRssi,
              gatewayLastCheckedAt: now,
              gatewayLastSuccessfulAt:
                response.providerResponseAt,
              gatewayLastError: null,
              gatewayRawPayload: response.raw,
              gatewayProviderResponseAt:
                response.providerResponseAt,
              gatewayNextCheckAt: nextCheckAt,
              gatewayDisconnectedSince: null,
              gatewayCheckReservationId:
                reservation?.id ?? null,
              lastSyncAt: now,
              lastSeenAt: now,
              source: "WORKER",
              rawPayload: {
                telemetryType: "GATEWAY",
                gatewayId: response.gatewayId,
                isOnline: response.isOnline,
                providerRequestCount:
                  response.providerRequestCount,
              },
            });

            await resolveGatewayMaintenanceIssue({
              prisma,
              organizationId: lock.property.organizationId,
              propertyId: lock.propertyId,
              lockId: lock.id,
              lockName: getLockDisplayName(lock),
              propertyName: lock.property.name,
              occurredAt: now,
            });

            if (reservation) {
              await resolveGatewayReadinessIssue({
                prisma,
                organizationId:
                  lock.property.organizationId,
                propertyId: lock.propertyId,
                reservationId: reservation.id,
                reservationNumber:
                  reservation.reservationNumber,
                lockId: lock.id,
                lockName: getLockDisplayName(lock),
                propertyName: lock.property.name,
                occurredAt: now,
              });
            }
          } else {
            const alert = await recordGatewayFailure({
              lock,
              mode,
              reservation,
              now,
              gatewayConnected: false,
              isOnline: response.isOnline,
              gatewayRssi: response.gatewayRssi,
              error: response.hasGateway
                ? "TTLock gateway is offline"
                : "TTLock lock is not associated with a gateway",
              rawPayload: response.raw,
              providerResponseAt:
                response.providerResponseAt,
            });

            if (alert.sent) criticalEmailsSent += 1;
          }
        } catch (error) {
          const gatewayError =
            error instanceof TTLockGatewayStatusError
              ? error
              : null;

          ttlockRequestsTotal +=
            gatewayError?.providerRequestCount ?? 1;

          const definitiveNoGateway =
            gatewayError?.errcode === -2012;

          const alert = await recordGatewayFailure({
            lock,
            mode,
            reservation,
            now,
            gatewayConnected:
              definitiveNoGateway ? false : null,
            isOnline:
              definitiveNoGateway ? false : null,
            error:
              gatewayError?.message ??
              (error instanceof Error
                ? error.message
                : String(error)),
            rawPayload:
              gatewayError?.rawPayload ?? undefined,
          });

          if (alert.sent) criticalEmailsSent += 1;
        }
      } else {
        gatewaySkipped += 1;
      }

      const latestHealth = await prisma.deviceHealth.findUnique({
        where: { lockId: lock.id },
        select: {
          healthStatus: true,
          battery: true,
          gatewayConnected: true,
          lastSeenAt: true,
        },
      });

      if (!latestHealth) continue;

      const nextCheckInAt = reservation?.checkIn ?? null;
      const risk = computeOperationalRisk({
        healthStatus: latestHealth.healthStatus,
        battery: latestHealth.battery,
        gatewayConnected: latestHealth.gatewayConnected,
        lastSeenAt: latestHealth.lastSeenAt,
        nextCheckInAt,
        hasActiveAccess: false,
      });

      if (
        latestHealth.gatewayConnected === false &&
        nextCheckInAt
      ) {
        const hoursToCheckIn =
          (nextCheckInAt.getTime() - now.getTime()) /
          HOUR_MS;

        if (hoursToCheckIn <= 6) {
          risk.operationalRisk = "CRITICAL";
          risk.operationalMessage =
            "Gateway unavailable six hours before check-in. Immediate action is required.";
          risk.recommendedAction =
            "Restore gateway connectivity before guest arrival.";
        } else {
          risk.operationalRisk = "WARNING";
          risk.operationalMessage =
            "Gateway connectivity is unavailable before an upcoming check-in.";
          risk.recommendedAction =
            "Verify gateway connectivity before guest arrival.";
        }
      }

      if (
        latestHealth.battery !== null &&
        latestHealth.battery < BATTERY_CRITICAL_THRESHOLD &&
        nextCheckInAt
      ) {
        risk.operationalRisk = "CRITICAL";
        risk.operationalMessage =
          `Battery is below ${BATTERY_CRITICAL_THRESHOLD}% before an upcoming check-in.`;
        risk.recommendedAction =
          "Replace the lock batteries before guest arrival.";
      }

      await prisma.deviceHealth.update({
        where: { lockId: lock.id },
        data: {
          operationalRisk: risk.operationalRisk,
          operationalMessage: risk.operationalMessage,
          recommendedAction: risk.recommendedAction,
          nextCheckInAt,
          hasActiveAccess: false,
          riskCalculatedAt: now,
        },
      });
    } catch (error) {
      console.error(
        "DeviceHealth hardened worker failed for lock",
        {
          lockId: lock.id,
          error:
            error instanceof Error
              ? error.stack || error.message
              : String(error),
        }
      );
    }
  }

  console.log("DeviceHealth hardened worker finished", {
    locksEvaluated: locks.length,
    gatewayEligible,
    gatewayDisabled,
    legacyUnconfigured,
    reservationsInside24Hours: upcomingReservations.length,
    batteryDue,
    batterySkipped,
    gatewayDue,
    gatewaySkipped,
    batteryCalls,
    gatewayCalls,
    ttlockRequestsTotal,
    criticalEmailsSent,
    completedAt: new Date().toISOString(),
  });
}
