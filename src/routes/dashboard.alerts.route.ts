import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import {
  gatewayMonitoringModeFromPolicy,
  loadGatewayMonitoringPolicies,
  shouldSurfaceDeviceHealthAlert,
} from "../services/lockGatewayMonitoring.service";

const prisma = new PrismaClient();
export const dashboardAlertsRouter = Router();

async function buildAlertsForOrg(orgId: string) {
  const locks = await prisma.lock.findMany({
    where: {
      isActive: true,
      property: {
        organizationId: orgId,
      },
    },
    select: {
      id: true,
      ttlockLockName: true,
      property: {
        select: {
          name: true,
        },
      },
      ttlockGateway: {
        select: {
          isOnline: true,
        },
      },
      deviceHealth: {
        select: {
          battery: true,
          gatewayConnected: true,
          healthStatus: true,
          healthMessage: true,
          updatedAt: true,
        },
      },
    },
  });

  const gatewayPolicies = await loadGatewayMonitoringPolicies(prisma, {
    organizationId: orgId,
    lockIds: locks.map((lock) => lock.id),
  });

  const visibleRows = locks
    .map((lock) => {
      const mode = gatewayMonitoringModeFromPolicy(
        gatewayPolicies.get(lock.id) ?? null
      );

      if (!shouldSurfaceDeviceHealthAlert(mode)) {
        return null;
      }

      const health = lock.deviceHealth;
      const gatewayOffline =
        lock.ttlockGateway?.isOnline === false;
      const healthStatus = gatewayOffline
        ? "OFFLINE"
        : health?.healthStatus ?? "UNKNOWN";

      if (
        !["LOW_BATTERY", "WARNING", "OFFLINE"].includes(
          healthStatus
        )
      ) {
        return null;
      }

      return {
        lockId: lock.id,
        lockName:
          lock.ttlockLockName ?? "Lock",
        propertyName:
          lock.property?.name ?? null,
        battery: health?.battery ?? null,
        gatewayConnected:
          lock.ttlockGateway?.isOnline ??
          health?.gatewayConnected ??
          null,
        healthStatus,
        healthMessage: gatewayOffline
          ? "Shared TTLock gateway offline"
          : health?.healthMessage ?? null,
        updatedAt:
          health?.updatedAt ?? new Date(0),
      };
    })
    .filter(
      (
        row
      ): row is NonNullable<typeof row> =>
        row !== null
    )
    .sort(
      (a, b) =>
        b.updatedAt.getTime() -
        a.updatedAt.getTime()
    );

  return {
    ok: true,
    total: visibleRows.length,
    items: visibleRows,
  };
}

/*
---------------------------------------
Ruta real usada por el Dashboard
---------------------------------------
*/
dashboardAlertsRouter.get(
  "/api/dashboard/locks/alerts",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const orgId = user.orgId as string;

      const payload = await buildAlertsForOrg(orgId);

      return res.json(payload);
    } catch (e: any) {
      console.error("dashboard alerts failed:", e);

      return res.status(500).json({
        ok: false,
        error: e?.message ?? "dashboard alerts failed",
      });
    }
  }
);

/*
---------------------------------------
Ruta DEV abierta para pruebas
---------------------------------------
*/
dashboardAlertsRouter.get("/api/dev/locks/alerts", async (_req, res) => {
  try {
    const orgId =
      process.env.DEV_ORG_ID ?? "cmlk0fpl60000n0o0vo87t6tm";

    const payload = await buildAlertsForOrg(orgId);

    return res.json(payload);
  } catch (e: any) {
    console.error("dev dashboard alerts failed:", e);

    return res.status(500).json({
      ok: false,
      error: e?.message ?? "dev dashboard alerts failed",
    });
  }
});
