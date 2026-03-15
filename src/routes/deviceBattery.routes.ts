import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { refreshBatteryForLock } from "../services/deviceHealth.battery.sync";

export default function buildDeviceBatteryRouter(prisma: PrismaClient) {
  const router = Router();

  router.post("/api/dev/locks/:lockId/battery/refresh", async (req, res) => {
    try {
      const { lockId } = req.params;

      const result = await refreshBatteryForLock(prisma, lockId);

      return res.json({
        ok: true,
        battery: result.telemetry.battery,
        item: result.saved,
      });
    } catch (e: any) {
      console.error("Battery refresh failed:", e);

      return res.status(500).json({
        ok: false,
        error: e?.message ?? "battery refresh failed",
      });
    }
  });

  return router;
}
