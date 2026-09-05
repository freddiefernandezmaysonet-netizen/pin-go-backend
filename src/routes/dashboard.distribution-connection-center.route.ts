import type { PrismaClient } from "@prisma/client";
import { Router } from "express";

import { requireAuth } from "../middleware/requireAuth";
import {
  buildConnectionCenterReadModel,
  type ConnectionCenterProvider,
  type StoredOtaChannel,
} from "../distribution/connection-center.read-model";

export function buildDashboardDistributionConnectionCenterRouter(
  prisma: PrismaClient
) {
  const router = Router();

  for (const legacyMutationPath of [
    "/api/dashboard/properties/:propertyId/distribution/enable",
    "/api/dashboard/properties/:propertyId/channex/provision",
    "/api/dashboard/properties/:propertyId/channex/sync-availability",
  ]) {
    router.post(legacyMutationPath, requireAuth, (_req, res) =>
      res.status(409).json({
        ok: false,
        error: "OTA_DISTRIBUTION_CONNECTION_CENTER_REQUIRED",
      })
    );
  }

  router.get(
    "/api/dashboard/distribution/properties/:propertyId",
    requireAuth,
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");

      try {
        const organizationId = String((req as any).user?.orgId ?? "").trim();
        const propertyId = String(req.params.propertyId ?? "").trim();
        const property = await prisma.property.findFirst({
          where: { id: propertyId, organizationId, status: "ACTIVE" },
          select: { id: true, name: true },
        });

        if (!property) {
          return res.status(404).json({
            ok: false,
            error: "DISTRIBUTION_PROPERTY_NOT_FOUND",
          });
        }

        const distributionProperty =
          await prisma.distributionProperty.findFirst({
            where: { propertyId: property.id, organizationId, platform: "CHANNEX" },
            select: {
              organizationId: true,
              provisioningStatus: true,
              otaChannelConnections: {
                select: {
                  organizationId: true,
                  propertyId: true,
                  provider: true,
                  status: true,
                  authorizationReadiness: true,
                  mappingReadiness: true,
                  distributionReadiness: true,
                  paymentReadiness: true,
                  taxReadiness: true,
                  contentReadiness: true,
                  lastReadinessCheckedAt: true,
                  lastFullSyncConfirmedAt: true,
                  activatedAt: true,
                  lastErrorCode: true,
                },
                orderBy: { provider: "asc" },
              },
            },
          });

        if (
          distributionProperty &&
          (distributionProperty.organizationId !== organizationId ||
            distributionProperty.otaChannelConnections.some(
              (channel) =>
                channel.organizationId !== organizationId ||
                channel.propertyId !== property.id
            ))
        ) {
          return res.status(409).json({
            ok: false,
            error: "OTA_DISTRIBUTION_TENANT_MISMATCH",
          });
        }

        const connectionCenter = buildConnectionCenterReadModel({
          property,
          distributionProperty: distributionProperty
            ? {
                provisioningStatus: distributionProperty.provisioningStatus,
                channels:
                  distributionProperty.otaChannelConnections as Array<
                    StoredOtaChannel & { provider: ConnectionCenterProvider }
                  >,
              }
            : null,
        });

        return res.json({ ok: true, connectionCenter });
      } catch (error) {
        console.error("[distribution.connection-center] lookup failed", {
          errorType: error instanceof Error ? error.name : typeof error,
        });
        return res.status(500).json({
          ok: false,
          error: "DISTRIBUTION_CONNECTION_CENTER_FETCH_FAILED",
        });
      }
    }
  );

  return router;
}
