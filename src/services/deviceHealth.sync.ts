import { PrismaClient } from "@prisma/client";
import { ttlockFetchDeviceHealth } from "../ttlock/ttlock.deviceHealth";
import { upsertDeviceHealth } from "./deviceHealth.service";

export async function refreshDeviceHealthForLock(
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

  const ttlock = await ttlockFetchDeviceHealth(lock.ttlockLockId);

  const saved = await upsertDeviceHealth(prisma, {
    lockId: lock.id,
    battery: ttlock.battery ?? null,
    gatewayConnected: ttlock.gatewayConnected ?? null,
    isOnline: ttlock.isOnline ?? null,
    lastSyncAt: new Date(),
    lastSeenAt: new Date(),
    source: "TTLOCK_DIRECT",
    rawPayload: ttlock.raw,
  });

  return {
    lock,
    ttlock,
    saved,
  };
}