import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import {
  gatewayMonitoringModeFromPolicy,
  loadGatewayMonitoringPolicies,
  setGatewayMonitoringPolicy,
} from "../services/lockGatewayMonitoring.service";
import { applyGatewayMonitoringConfiguration } from "../services/gatewayConfigurationVerification.service";

const prisma = new PrismaClient();
export const dashboardLocksRouter = Router();

function toInt(v: any, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

dashboardLocksRouter.get("/api/dashboard/locks", requireAuth, async (req, res) => {
  const user = (req as any).user;
  const orgId = user.orgId as string;

  const propertyId =
    typeof req.query.propertyId === "string" ? req.query.propertyId : undefined;
  const search =
    typeof req.query.search === "string" ? req.query.search.trim() : "";

  const page = clamp(toInt(req.query.page, 1), 1, 10_000);
  const pageSize = clamp(toInt(req.query.pageSize, 25), 1, 100);

  const where: any = {
    property: { organizationId: orgId },
  };

  if (propertyId) where.propertyId = propertyId;

  if (search) {
    const maybeId = Number(search);
    where.OR = [
      { displayName: { contains: search, mode: "insensitive" } },
      { ttlockLockName: { contains: search, mode: "insensitive" } },
      ...(Number.isFinite(maybeId) ? [{ ttlockLockId: maybeId }] : []),
    ];
  }

  const skip = (page - 1) * pageSize;

  const [total, rows] = await Promise.all([
    prisma.lock.count({ where }),
    prisma.lock.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip,
      take: pageSize,
      select: {
        id: true,
        ttlockLockId: true,
        ttlockLockName: true,
        displayName: true,
        isActive: true,
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
            isOnline: true,
            lastSeenAt: true,
            lastSyncAt: true,
            healthStatus: true,
            healthMessage: true,
            updatedAt: true,
          },
        },
      },
    }),
  ]);

  const gatewayPolicies = await loadGatewayMonitoringPolicies(prisma, {
    organizationId: orgId,
    lockIds: rows.map((lock) => lock.id),
  });

  return res.json({
    page,
    pageSize,
    total,
    items: rows.map((l) => ({
      id: l.id,
      ttlockLockId: l.ttlockLockId,
      name: l.displayName ?? l.ttlockLockName ?? null,
      isActive: l.isActive,
      updatedAt: l.updatedAt.toISOString(),
      property: l.property,

      gatewayMonitoringMode: gatewayMonitoringModeFromPolicy(
        gatewayPolicies.get(l.id) ?? null
      ),

      battery: l.deviceHealth?.battery ?? null,
      batteryFresh: !!l.deviceHealth?.lastSyncAt,

      gatewayId: null as number | null,
      gatewayName: null as string | null,
      gatewayOnline: l.deviceHealth?.gatewayConnected ?? null,
      gatewayFresh: !!l.deviceHealth?.lastSyncAt,

      deviceHealth: l.deviceHealth
        ? {
            battery: l.deviceHealth.battery ?? null,
            gatewayConnected: l.deviceHealth.gatewayConnected ?? null,
            isOnline: l.deviceHealth.isOnline ?? null,
            lastSeenAt: l.deviceHealth.lastSeenAt
              ? l.deviceHealth.lastSeenAt.toISOString()
              : null,
            lastSyncAt: l.deviceHealth.lastSyncAt
              ? l.deviceHealth.lastSyncAt.toISOString()
              : null,
            healthStatus: l.deviceHealth.healthStatus,
            healthMessage: l.deviceHealth.healthMessage ?? null,
            updatedAt: l.deviceHealth.updatedAt.toISOString(),
          }
        : null,
    })),
  });
});

dashboardLocksRouter.patch(
  "/api/dashboard/locks/:lockId/gateway-monitoring",
  requireAuth,
  async (req, res) => {
    const user = (req as any).user;
    const orgId = user.orgId as string;
    const lockId = String(req.params.lockId ?? "").trim();
    const gatewayInstalled = req.body?.gatewayInstalled;

    if (!lockId) {
      return res.status(400).json({
        ok: false,
        error: "LOCK_ID_REQUIRED",
      });
    }

    if (typeof gatewayInstalled !== "boolean") {
      return res.status(400).json({
        ok: false,
        error: "GATEWAY_INSTALLED_BOOLEAN_REQUIRED",
      });
    }

    const lock = await prisma.lock.findFirst({
      where: {
        id: lockId,
        property: {
          organizationId: orgId,
        },
      },
      select: {
        id: true,
        propertyId: true,
        ttlockLockId: true,
      },
    });

    if (!lock) {
      return res.status(404).json({
        ok: false,
        error: "LOCK_NOT_FOUND",
      });
    }

    const policy = await setGatewayMonitoringPolicy(prisma, {
      organizationId: orgId,
      propertyId: lock.propertyId,
      lockId: lock.id,
      enabled: gatewayInstalled,
      configuredBy: user.id ?? null,
    });

    const verification = await applyGatewayMonitoringConfiguration(prisma, {
      lockId: lock.id,
      ttlockLockId: lock.ttlockLockId,
      enabled: gatewayInstalled,
    });

    return res.json({
      ok: true,
      lockId: lock.id,
      gatewayInstalled,
      gatewayMonitoringMode: gatewayInstalled ? "ENABLED" : "DISABLED",
      configuredAt: policy.updatedAt.toISOString(),
      verification: {
        state: verification.state,
        gatewayConnected: verification.gatewayConnected,
        isOnline: verification.isOnline,
        nextCheckAt: verification.nextCheckAt?.toISOString() ?? null,
        providerRequestCount: verification.providerRequestCount,
        error: verification.error,
      },
    });
  }
);