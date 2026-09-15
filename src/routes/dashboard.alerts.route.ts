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
  const rows = await prisma.deviceHealth.findMany({
    where: {
      organizationId: orgId,
      healthStatus: {
        in: ["LOW_BATTERY", "WARNING", "OFFLINE"],
      },
      lock: {
        isActive: true,
      },
    },
    select: {
      lockId: true,
      battery: true,
      gatewayConnected: true,
      healthStatus: true,
      healthMessage: true,
      updatedAt: true,
      lock: {
        select: {
          id: true,
          ttlockLockName: true,
          property: {
            select: {
              name: true,
            },
          },
        },
      },
    },
    orderBy: {
      updatedAt: "desc",
    },
  });

  const gatewayPolicies = await loadGatewayMonitoringPolicies(prisma, {
    organizationId: orgId,
    lockIds: rows.map((row) => row.lockId),
  });

  const visibleRows = rows.filter((row) => {
    const mode = gatewayMonitoringModeFromPolicy(
      gatewayPolicies.get(row.lockId) ?? null
    );

    return shouldSurfaceDeviceHealthAlert(mode);
  });

  return {
    ok: true,
    total: visibleRows.length,
    items: visibleRows.map((r) => ({
      lockId: r.lockId,
      lockName: r.lock?.ttlockLockName ?? "Lock",
      propertyName: r.lock?.property?.name ?? null,
      battery: r.battery,
      gatewayConnected: r.gatewayConnected,
      healthStatus: r.healthStatus,
      healthMessage: r.healthMessage,
      updatedAt: r.updatedAt,
    })),
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
