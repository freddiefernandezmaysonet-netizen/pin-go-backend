import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { ttlockFetchGateway } from "../ttlock/ttlock.deviceGateway";

export default function buildDeviceGatewayRouter(prisma: PrismaClient) {
  const router = Router();

  router.post("/api/dev/locks/:lockId/gateway/refresh", async (req, res) => {
    try {
      const { lockId } = req.params;

      const lock = await prisma.lock.findUnique({
        where: { id: String(lockId) },
        select: {
          id: true,
          propertyId: true,
          property: {
            select: {
              id: true,
              organizationId: true,
            },
          },
          ttlockLockId: true,
          deviceHealth: {
            select: {
              battery: true,
              lastEventAt: true,
              lastSeenAt: true,
            },
          },
        },
      });

      if (!lock) {
        return res.status(404).json({
          ok: false,
          error: "Lock not found",
        });
      }

      if (!lock.property?.organizationId) {
        return res.status(400).json({
          ok: false,
          error: "Lock missing organization relation",
        });
      }

      const gateway = await ttlockFetchGateway(lock.ttlockLockId);

      const item = await prisma.deviceHealth.upsert({
        where: { lockId: lock.id },
        create: {
          lockId: lock.id,
          organizationId: lock.property.organizationId,
          propertyId: lock.property.id,
          battery: lock.deviceHealth?.battery ?? null,
          gatewayConnected: gateway.hasGateway,
          lastSyncAt: new Date(),
          lastEventAt: lock.deviceHealth?.lastEventAt ?? null,
          lastSeenAt: lock.deviceHealth?.lastSeenAt ?? new Date(),
          source: "GATEWAY_REFRESH",
          rawPayload: {
            gateway: gateway.raw,
          },
          healthStatus: "HEALTHY",
          healthMessage: gateway.hasGateway
            ? "Gateway detected"
            : "No gateway detected",
        },
        update: {
          gatewayConnected: gateway.hasGateway,
          lastSyncAt: new Date(),
          source: "GATEWAY_REFRESH",
          rawPayload: {
            gateway: gateway.raw,
          },
          healthStatus: "HEALTHY",
          healthMessage: gateway.hasGateway
            ? "Gateway detected"
            : "No gateway detected",
        },
      });

      return res.json({
        ok: true,
        lockId: lock.id,
        ttlockLockId: lock.ttlockLockId,
        hasGateway: gateway.hasGateway,
        item,
      });
    } catch (e: any) {
      console.error("Gateway refresh failed:", e);
      return res.status(500).json({
        ok: false,
        error: e?.message ?? "gateway refresh failed",
      });
    }
  });

  return router;
}
