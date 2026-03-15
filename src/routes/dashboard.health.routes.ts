import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

export function buildDashboardHealthRouter(prisma: PrismaClient) {
  const router = Router();

  // ============================
  // SUMMARY
  // ============================
  router.get("/summary", async (_req, res) => {
    try {
      const locks = await prisma.lock.findMany({
        where: { isActive: true },
        select: {
          id: true,
          deviceHealth: {
            select: {
              healthStatus: true,
            },
          },
        },
      });

      let healthy = 0;
      let warning = 0;
      let critical = 0;
      let unknown = 0;

      for (const l of locks) {
        const status = l.deviceHealth?.healthStatus;

        if (!status) {
          unknown++;
          continue;
        }

        if (status === "HEALTHY") healthy++;
        else if (status === "LOW_BATTERY") warning++;
        else if (status === "CRITICAL") critical++;
        else if (status === "OFFLINE") critical++;
        else unknown++;
      }

      res.json({
        ok: true,
        summary: {
          healthy,
          warning,
          critical,
          unknown,
          openAlerts: warning + critical,
        },
      });
    } catch (err) {
      console.error("health summary error", err);

      res.status(500).json({
        ok: false,
        error: "Failed to compute health summary",
      });
    }
  });

  // ============================
  // LOCKS TABLE
  // ============================
  router.get("/locks", async (_req, res) => {
    try {
      const locks = await prisma.lock.findMany({
        where: {
          isActive: true,
        },
        select: {
          id: true,
          ttlockLockId: true,
          ttlockLockName: true,
          locationLabel: true,

          property: {
            select: {
              id: true,
              name: true,
            },
          },

          deviceHealth: {
            select: {
              battery: true,
              isOnline: true,
              gatewayConnected: true,
              healthStatus: true,
              lastSeenAt: true,
            },
          },

          updatedAt: true,
        },
        orderBy: {
          updatedAt: "desc",
        },
      });

      const items = locks.map((lock) => {
        const health = lock.deviceHealth;

        const name =
          lock.ttlockLockName ??
          lock.locationLabel ??
          `Lock ${lock.ttlockLockId}`;

        return {
          id: lock.id,
          name,
          property: lock.property ?? null,

          battery: health?.battery ?? null,
          isOnline: health?.isOnline ?? null,
          gatewayConnected: health?.gatewayConnected ?? null,

          lastSeenAt: health?.lastSeenAt ?? lock.updatedAt,

          healthStatus: health?.healthStatus ?? "UNKNOWN",
        };
      });

      res.json({
        ok: true,
        items,
      });
    } catch (err) {
      console.error("health locks error", err);

      res.status(500).json({
        ok: false,
        error: "Failed to load health locks",
      });
    }
  });

  return router;
}