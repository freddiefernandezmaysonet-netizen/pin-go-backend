import { PrismaClient } from "@prisma/client";
import { ttlockFetchBattery } from "../ttlock/ttlock.deviceBattery";
import { ttlockFetchGateway } from "../ttlock/ttlock.deviceGateway";
import { upsertDeviceHealth } from "../services/deviceHealth.service";

const prisma = new PrismaClient();

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHLY_INTERVAL_MS = 30 * DAY_MS;
const WEEKLY_INTERVAL_MS = 7 * DAY_MS;
const LOW_BATTERY_REFRESH_THRESHOLD = 40;

export async function runDeviceHealthWorker() {
  console.log("🔋 DeviceHealth worker starting...");

  const locks = await prisma.lock.findMany({
    where: {
      isActive: true,
    },
    select: {
      id: true,
      ttlockLockId: true,
      deviceHealth: {
        select: {
          battery: true,
          lastSyncAt: true,
        },
      },
    },
  });

  console.log(`🔎 Checking ${locks.length} active locks`);

  const now = Date.now();

  for (const lock of locks) {
    try {
      const currentBattery = lock.deviceHealth?.battery ?? null;
      const lastSyncAt = lock.deviceHealth?.lastSyncAt?.getTime() ?? null;

      let requiredInterval = MONTHLY_INTERVAL_MS;

      if (
        currentBattery !== null &&
        currentBattery < LOW_BATTERY_REFRESH_THRESHOLD
      ) {
        requiredInterval = WEEKLY_INTERVAL_MS;
      }

      const needsRefresh = !lastSyncAt || now - lastSyncAt >= requiredInterval;

      if (!needsRefresh) {
        console.log(
          `⏭️ Skipping active lock ${lock.id} battery=${currentBattery ?? "unknown"} lastSync=${lock.deviceHealth?.lastSyncAt?.toISOString() ?? "never"}`
        );
        continue;
      }

      const battery = await ttlockFetchBattery(lock.ttlockLockId);
      const gateway = await ttlockFetchGateway(lock.ttlockLockId);

      await upsertDeviceHealth(prisma, {
        lockId: lock.id,
        battery: battery.battery,
        gatewayConnected: gateway.hasGateway,
        lastSyncAt: new Date(),
        lastSeenAt: new Date(),
        source: "WORKER",
        rawPayload: {
          battery: battery.raw,
          gateway: gateway.raw,
        },
      });

      console.log(
        `✅ Active lock ${lock.id} battery=${battery.battery} gateway=${gateway.hasGateway}`
      );
    } catch (err) {
      console.error(`❌ Worker failed for active lock ${lock.id}`, err);
    }
  }

  console.log("✅ DeviceHealth worker finished");
}
