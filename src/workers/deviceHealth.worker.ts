import { PrismaClient } from "@prisma/client";
import { ttlockFetchBattery } from "../ttlock/ttlock.deviceBattery";
import { ttlockFetchGateway } from "../ttlock/ttlock.deviceGateway";
import { upsertDeviceHealth } from "../services/deviceHealth.service";
import { computeOperationalRisk } from "../domain/computeOperationalRisk";

const prisma = new PrismaClient();

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MONTHLY_INTERVAL_MS = 30 * DAY_MS;
const WEEKLY_INTERVAL_MS = 7 * DAY_MS;
const GATEWAY_REFRESH_INTERVAL_MS = 24 * HOUR_MS;
const STALE_SYNC_MS = 7 * DAY_MS;
const LOW_BATTERY_REFRESH_THRESHOLD = 40;

function getTtlockErrorInfo(err: unknown): {
  errcode: number | null;
  errmsg: string;
} {
  const message = err instanceof Error ? err.message : String(err);

  const errcodeMatch = message.match(/errcode=([-\d]+)/);
  const errmsgMatch = message.match(/errmsg=(.*)$/);

  return {
    errcode: errcodeMatch ? Number(errcodeMatch[1]) : null,
    errmsg: errmsgMatch ? errmsgMatch[1] : message,
  };
}

export async function runDeviceHealthWorker() {
  console.log("🔋 DeviceHealth worker starting...");

  const nowDate = new Date();
  const nowMs = Date.now();

  const upcomingReservations = await prisma.reservation.findMany({
    where: {
      checkIn: {
        gte: nowDate,
      },
    },
    select: {
      propertyId: true,
      checkIn: true,
    },
    orderBy: {
      checkIn: "asc",
    },
  });

  const nextCheckInByProperty = new Map<string, Date>();

  for (const r of upcomingReservations) {
    const existing = nextCheckInByProperty.get(r.propertyId);
    if (!existing || r.checkIn < existing) {
      nextCheckInByProperty.set(r.propertyId, r.checkIn);
    }
  }

  const locks = await prisma.lock.findMany({
    where: {
      isActive: true,
    },
    select: {
      id: true,
      propertyId: true,
      ttlockLockId: true,
      ttlockLockName: true,
      locationLabel: true,
      deviceHealth: {
        select: {
          battery: true,
          gatewayConnected: true,
          isOnline: true,
          lastSeenAt: true,
          lastSyncAt: true,
        },
      },
    },
  });

  console.log(`🔎 Checking ${locks.length} active locks`);

  for (const lock of locks) {
    try {
      const currentBattery = lock.deviceHealth?.battery ?? null;
      const currentGatewayConnected = lock.deviceHealth?.gatewayConnected ?? null;
      const currentIsOnline = lock.deviceHealth?.isOnline ?? null;
      const lastSeenAt = lock.deviceHealth?.lastSeenAt ?? null;
      const lastSyncAt = lock.deviceHealth?.lastSyncAt ?? null;
      const nextCheckInAt = nextCheckInByProperty.get(lock.propertyId) ?? null;

      const missingCoreTelemetry =
        currentBattery === null ||
        currentGatewayConnected === null ||
        currentIsOnline === null ||
        !lastSeenAt;

      let requiredInterval = MONTHLY_INTERVAL_MS;

      if (
        currentBattery !== null &&
        currentBattery < LOW_BATTERY_REFRESH_THRESHOLD
      ) {
        requiredInterval = WEEKLY_INTERVAL_MS;
      }

      let staleGatewayTelemetry = false;
      if (lastSyncAt) {
        const syncAge = nowMs - lastSyncAt.getTime();
        if (syncAge > GATEWAY_REFRESH_INTERVAL_MS) {
          staleGatewayTelemetry = true;
        }
      } else {
        staleGatewayTelemetry = true;
      }

      let forceGatewayCheck = false;
      if (nextCheckInAt) {
        const hoursToCheckIn =
          (nextCheckInAt.getTime() - nowMs) / HOUR_MS;
        if (hoursToCheckIn <= 24) {
          forceGatewayCheck = true;
        }
      }

      let staleTelemetry = false;
      if (lastSyncAt) {
        const syncAge = nowMs - lastSyncAt.getTime();
        if (syncAge > STALE_SYNC_MS) {
          staleTelemetry = true;
        }
      }

      const lastSeenMs = lastSeenAt?.getTime() ?? null;

      const needsRefresh =
        missingCoreTelemetry ||
        !lastSeenMs ||
        nowMs - lastSeenMs >= requiredInterval ||
        staleGatewayTelemetry ||
        forceGatewayCheck ||
        staleTelemetry;

      let battery = currentBattery;
      let gatewayConnected = currentGatewayConnected;
      let isOnline = currentIsOnline;
      let effectiveLastSeenAt = lastSeenAt;

      if (needsRefresh) {
        try {
          const batteryResp = await ttlockFetchBattery(lock.ttlockLockId);
          const gatewayResp = await ttlockFetchGateway(lock.ttlockLockId);

          battery = batteryResp.battery;
          gatewayConnected = gatewayResp.hasGateway;
          isOnline = true;
          effectiveLastSeenAt = new Date();

          await upsertDeviceHealth(prisma, {
            lockId: lock.id,
            battery,
            gatewayConnected,
            isOnline,
            lastSyncAt: new Date(),
            lastSeenAt: effectiveLastSeenAt,
            source: "WORKER",
            rawPayload: {
              battery: batteryResp.raw,
              gateway: gatewayResp.raw,
            },
          });

          console.log(
            `✅ Active lock ${lock.id} battery=${battery} gateway=${gatewayConnected} nextCheckIn=${nextCheckInAt?.toISOString() ?? "none"}`
          );
        } catch (err) {
          const { errcode, errmsg } = getTtlockErrorInfo(err);

          if (errcode === -2012) {
            effectiveLastSeenAt = new Date();
            gatewayConnected = false;
            isOnline = false;

            await upsertDeviceHealth(prisma, {
              lockId: lock.id,
              gatewayConnected,
              isOnline,
              lastSyncAt: new Date(),
              lastSeenAt: effectiveLastSeenAt,
              source: "WORKER",
              rawPayload: {
                ttlockError: {
                  errcode,
                  errmsg,
                },
              },
            });

            console.warn(
              `⚠️ Lock ${lock.id} has no gateway connection (TTLock -2012)`
            );
          } else if (errcode === -2018) {
            await upsertDeviceHealth(prisma, {
              lockId: lock.id,
              lastSyncAt: new Date(),
              source: "WORKER",
              rawPayload: {
                ttlockError: {
                  errcode,
                  errmsg,
                },
              },
              healthOverrideStatus: "UNKNOWN",
              healthOverrideMessage:
                "TTLock permission denied. Pin&Go could not validate this lock.",
            });

            console.warn(
              `⚠️ Lock ${lock.id} permission denied in TTLock (TTLock -2018)`
            );
          } else if (errcode === 1) {
            await upsertDeviceHealth(prisma, {
              lockId: lock.id,
              lastSyncAt: new Date(),
              source: "WORKER",
              rawPayload: {
                ttlockError: {
                  errcode,
                  errmsg,
                },
              },
              healthOverrideStatus: "UNKNOWN",
              healthOverrideMessage:
                "TTLock returned an invalid/failed response. Pin&Go could not validate this lock.",
            });

            console.warn(
              `⚠️ Lock ${lock.id} could not be validated in TTLock (errcode=1)`
            );
          } else {
            throw err;
          }
        }
      } else {
        console.log(
          `⏭️ Skipping active lock ${lock.id} battery=${currentBattery ?? "unknown"} gateway=${currentGatewayConnected ?? "unknown"} online=${currentIsOnline ?? "unknown"} lastSeen=${lock.deviceHealth?.lastSeenAt?.toISOString() ?? "never"} nextCheckIn=${nextCheckInAt?.toISOString() ?? "none"}`
        );
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

      if (!latestHealth) {
        console.warn(
          `⚠️ deviceHealth row missing for lock ${lock.id}; skipping operational risk update`
        );
        continue;
      }

      const risk = computeOperationalRisk({
        healthStatus: latestHealth.healthStatus,
        battery: latestHealth.battery,
        gatewayConnected: latestHealth.gatewayConnected,
        lastSeenAt: latestHealth.lastSeenAt,
        nextCheckInAt,
        hasActiveAccess: false,
      });

      if (latestHealth.gatewayConnected === false && nextCheckInAt) {
        const hoursToCheckIn =
          (nextCheckInAt.getTime() - nowMs) / HOUR_MS;

        if (hoursToCheckIn <= 4) {
          risk.operationalRisk = "CRITICAL";
          risk.operationalMessage =
            "Gateway unavailable 4 hours before check-in. Immediate action required to avoid reservation issues.";
          risk.recommendedAction =
            "Verify gateway immediately and restore remote connectivity before guest arrival.";
        } else if (hoursToCheckIn <= 12) {
          risk.operationalRisk = "WARNING";
          risk.operationalMessage =
            "Gateway still unavailable 12 hours before check-in. Guest access preparation may be affected.";
          risk.recommendedAction =
            "Verify gateway connectivity and confirm remote readiness.";
        } else if (hoursToCheckIn <= 24) {
          risk.operationalRisk = "WARNING";
          risk.operationalMessage =
            "Gateway unavailable 24 hours before check-in. Verify remote readiness.";
          risk.recommendedAction =
            "Check gateway connection before the next reservation.";
        }
      }

      if (
        latestHealth.battery !== null &&
        latestHealth.battery < 30 &&
        nextCheckInAt
      ) {
        const hoursToCheckIn =
          (nextCheckInAt.getTime() - nowMs) / HOUR_MS;

        if (hoursToCheckIn <= 24) {
          risk.operationalRisk = "CRITICAL";
          risk.operationalMessage =
            "Battery below 30% and a reservation is scheduled soon. Replace batteries immediately to avoid problems during the reservation.";
          risk.recommendedAction =
            "Replace lock batteries before the next check-in.";
        }
      }

      await prisma.deviceHealth.update({
        where: { lockId: lock.id },
        data: {
          operationalRisk: risk.operationalRisk,
          operationalMessage: risk.operationalMessage,
          recommendedAction: risk.recommendedAction,
          nextCheckInAt,
          hasActiveAccess: false,
          riskCalculatedAt: new Date(),
        },
      });
    } catch (err) {
      console.error(`❌ Worker failed for active lock ${lock.id}`, err);
    }
  }

  console.log("✅ DeviceHealth worker finished");
}