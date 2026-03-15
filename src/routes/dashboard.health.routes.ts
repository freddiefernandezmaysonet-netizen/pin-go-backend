import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

function isVisibleRisk(risk?: string | null) {
  return risk !== "HEALTHY";
}

function riskRank(risk?: string | null) {
  switch (risk) {
    case "CRITICAL":
      return 1;
    case "AT_RISK":
      return 2;
    case "WARNING":
      return 3;
    case "UNKNOWN":
      return 4;
    case "HEALTHY":
    default:
      return 5;
  }
}

function getOrgId(req: any): string | null {
  return req?.user?.orgId ?? null;
}

export function buildDashboardHealthRouter(prisma: PrismaClient) {
  const router = Router();

  // ============================
  // SUMMARY
  // ============================
  router.get("/summary", async (req, res) => {
    try {
      const orgId = getOrgId(req);

      if (!orgId) {
        return res.status(401).json({
          ok: false,
          error: "Unauthorized",
        });
      }

      const locks = await prisma.lock.findMany({
        where: {
          isActive: true,
          property: {
            organizationId: orgId,
          },
        },
        select: {
          id: true,
          deviceHealth: {
            select: {
              operationalRisk: true,
            },
          },
        },
      });

      let healthy = 0;
      let warning = 0;
      let atRisk = 0;
      let critical = 0;
      let unknown = 0;

      for (const l of locks) {
        const risk = l.deviceHealth?.operationalRisk ?? "UNKNOWN";

        if (risk === "HEALTHY") {
          healthy++;
          continue;
        }

        if (risk === "WARNING") {
          warning++;
          continue;
        }

        if (risk === "AT_RISK") {
          atRisk++;
          continue;
        }

        if (risk === "CRITICAL") {
          critical++;
          continue;
        }

        unknown++;
      }

      res.json({
        ok: true,
        summary: {
          healthy,
          warning,
          atRisk,
          critical,
          unknown,
          openAlerts: warning + atRisk + critical + unknown,
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
  // SOLO LOCKS CON RIESGO VISIBLE
  // ============================
  router.get("/locks", async (req, res) => {
    try {
      const orgId = getOrgId(req);

      if (!orgId) {
        return res.status(401).json({
          ok: false,
          error: "Unauthorized",
        });
      }

      const locks = await prisma.lock.findMany({
        where: {
          isActive: true,
          property: {
            organizationId: orgId,
          },
        },
        select: {
          id: true,
          ttlockLockId: true,
          ttlockLockName: true,
          locationLabel: true,
          updatedAt: true,

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
              lastSeenAt: true,
              lastSyncAt: true,
              healthStatus: true,
              healthMessage: true,
              operationalRisk: true,
              operationalMessage: true,
              recommendedAction: true,
              nextCheckInAt: true,
              hasActiveAccess: true,
              riskCalculatedAt: true,
            },
          },
        },
      });

      const items = locks
        .map((lock) => {
          const health = lock.deviceHealth;

          const name =
            lock.ttlockLockName ??
            lock.locationLabel ??
            `Lock ${lock.ttlockLockId}`;

          const operationalRisk = health?.operationalRisk ?? "UNKNOWN";

          return {
            id: lock.id,
            name,
            property: lock.property ?? null,

            battery: health?.battery ?? null,
            isOnline: health?.isOnline ?? null,
            gatewayConnected: health?.gatewayConnected ?? null,

            healthStatus: health?.healthStatus ?? "UNKNOWN",
            healthMessage: health?.healthMessage ?? null,

            operationalRisk,
            operationalMessage: health?.operationalMessage ?? null,
            recommendedAction: health?.recommendedAction ?? null,

            nextCheckInAt: health?.nextCheckInAt ?? null,
            hasActiveAccess: health?.hasActiveAccess ?? false,

            lastSeenAt: health?.lastSeenAt ?? null,
            lastSyncAt: health?.lastSyncAt ?? null,
            riskCalculatedAt: health?.riskCalculatedAt ?? null,

            updatedAt: lock.updatedAt,
          };
        })
        .filter((item) => isVisibleRisk(item.operationalRisk))
        .sort((a, b) => {
          const riskCompare =
            riskRank(a.operationalRisk) - riskRank(b.operationalRisk);

          if (riskCompare !== 0) return riskCompare;

          const aCheckIn = a.nextCheckInAt
            ? new Date(a.nextCheckInAt).getTime()
            : Number.MAX_SAFE_INTEGER;

          const bCheckIn = b.nextCheckInAt
            ? new Date(b.nextCheckInAt).getTime()
            : Number.MAX_SAFE_INTEGER;

          if (aCheckIn !== bCheckIn) return aCheckIn - bCheckIn;

          const aUpdated = new Date(a.updatedAt).getTime();
          const bUpdated = new Date(b.updatedAt).getTime();

          return bUpdated - aUpdated;
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

  // ============================
  // CONTROL TOWER
  // TOP 5 LOCKS MÁS PELIGROSOS
  // ============================
  router.get("/control-tower", async (req, res) => {
    try {
      const orgId = getOrgId(req);

      if (!orgId) {
        return res.status(401).json({
          ok: false,
          error: "Unauthorized",
        });
      }

      const locks = await prisma.lock.findMany({
        where: {
          isActive: true,
          property: {
            organizationId: orgId,
          },
          deviceHealth: {
            is: {
              operationalRisk: {
                not: "HEALTHY",
              },
            },
          },
        },
        select: {
          id: true,
          ttlockLockId: true,
          ttlockLockName: true,
          locationLabel: true,
          updatedAt: true,

          property: {
            select: {
              id: true,
              name: true,
            },
          },

          deviceHealth: {
            select: {
              battery: true,
              gatewayConnected: true,
              operationalRisk: true,
              operationalMessage: true,
              recommendedAction: true,
              nextCheckInAt: true,
            },
          },
        },
      });

      const items = locks
        .map((lock) => {
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
            gatewayConnected: health?.gatewayConnected ?? null,
            operationalRisk: health?.operationalRisk ?? "UNKNOWN",
            operationalMessage: health?.operationalMessage ?? null,
            recommendedAction: health?.recommendedAction ?? null,
            nextCheckInAt: health?.nextCheckInAt ?? null,
            updatedAt: lock.updatedAt,
          };
        })
        .sort((a, b) => {
          const riskCompare =
            riskRank(a.operationalRisk) - riskRank(b.operationalRisk);

          if (riskCompare !== 0) return riskCompare;

          const aCheckIn = a.nextCheckInAt
            ? new Date(a.nextCheckInAt).getTime()
            : Number.MAX_SAFE_INTEGER;

          const bCheckIn = b.nextCheckInAt
            ? new Date(b.nextCheckInAt).getTime()
            : Number.MAX_SAFE_INTEGER;

          if (aCheckIn !== bCheckIn) return aCheckIn - bCheckIn;

          const aUpdated = new Date(a.updatedAt).getTime();
          const bUpdated = new Date(b.updatedAt).getTime();

          return bUpdated - aUpdated;
        })
        .slice(0, 5);

      res.json({
        ok: true,
        items,
      });
    } catch (err) {
      console.error("health control tower error", err);

      res.status(500).json({
        ok: false,
        error: "Failed to load health control tower",
      });
    }
  });

  return router;
}