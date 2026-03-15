import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { refreshDeviceHealthForLock } from "../services/deviceHealth.sync";

export default function buildDeviceHealthRouter(prisma: PrismaClient) {
  const router = Router();

  router.post("/api/dev/device-health/locks/:lockId/refresh", async (req, res) => {
    console.log(">>> DEVICE HEALTH DEV ROUTE HIT", req.params.lockId);

    try {
      const { lockId } = req.params;

      if (!lockId) {
        return res.status(400).json({
          ok: false,
          error: "Missing lockId",
        });
      }

      const result = await refreshDeviceHealthForLock(prisma, String(lockId));

      return res.json({
        ok: true,
        item: result.saved,
      });
    } catch (e: any) {
      console.error("Device health refresh failed:", e);
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "device health refresh failed",
      });
    }
  });

  router.get("/api/dev/device-health/locks/:lockId", async (req, res) => {
    console.log(">>> DEVICE HEALTH DEV GET HIT", req.params.lockId);

    try {
      const { lockId } = req.params;

      if (!lockId) {
        return res.status(400).json({
          ok: false,
          error: "Missing lockId",
        });
      }

      const item = await prisma.deviceHealth.findUnique({
        where: { lockId: String(lockId) },
        select: {
          id: true,
          lockId: true,
          battery: true,
          gatewayConnected: true,
          isOnline: true,
          lastSyncAt: true,
          lastEventAt: true,
          lastSeenAt: true,
          healthStatus: true,
          healthMessage: true,
          source: true,
          updatedAt: true,
        },
      });

      if (!item) {
        return res.status(404).json({
          ok: false,
          error: "Device health not found",
        });
      }

      return res.json({
        ok: true,
        item,
      });
    } catch (e: any) {
      console.error("Device health fetch failed:", e);
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "device health fetch failed",
      });
    }
  });

  return router;
}