import { PrismaClient } from "@prisma/client";
import { ttlockFetchBattery } from "../ttlock/ttlock.deviceBattery";
import { upsertDeviceHealth } from "./deviceHealth.service";

export async function refreshBatteryForLock(
  prisma: PrismaClient,
  lockId: string
) {
  const lock = await prisma.lock.findUnique({
    where: { id: lockId },
    select: {
      id: true,
      ttlockLockId: true,
    },
  });

  if (!lock) {
    throw new Error("Lock not found");
  }

  const telemetry = await ttlockFetchBattery(lock.ttlockLockId);

  const saved = await upsertDeviceHealth(prisma, {
    lockId: lock.id,
    battery: telemetry.battery,
    lastSyncAt: new Date(),
    lastSeenAt: new Date(),
    source: "TTLOCK_BATTERY",
    rawPayload: telemetry.raw,
  });

  return {
    lock,
    telemetry,
    saved,
  };
}
