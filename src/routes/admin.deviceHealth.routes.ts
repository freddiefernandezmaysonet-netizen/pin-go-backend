import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { upsertDeviceHealth } from "../services/deviceHealth.service";
import { requireAuth } from "../middleware/requireAuth";

export function buildAdminDeviceHealthRouter(prisma: PrismaClient) {
  const router = Router();

  router.use(requireAuth);

  router.post("/api/admin/locks/:lockId/health/refresh", async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;
      const { lockId } = req.params;

      const lock = await prisma.lock.findFirst({
        where: {
          id: lockId,
          property: {
            organizationId: orgId,
          },
        },
        select: {
          id: true,
          ttlockLockId: true,
          battery: true,
        },
      });

      if (!lock) {
        return res.status(404).json({
          ok: false,
          error: "Lock not found",
        });
      }

      const result = await upsertDeviceHealth(prisma, {
        lockId: lock.id,
        battery: lock.battery ?? null,
        gatewayConnected: null,
        isOnline: true,
        lastSyncAt: new Date(),
        lastSeenAt: new Date(),
        source: "MANUAL_REFRESH",
        rawPayload: {
          ttlockLockId: lock.ttlockLockId,
          battery: lock.battery ?? null,
        },
      });

      return res.json({
        ok: true,
        item: result,
      });
    } catch (error: any) {
      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Internal server error",
      });
    }
  });

  return router;
}