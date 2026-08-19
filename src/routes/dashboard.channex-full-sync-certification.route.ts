import crypto from "crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { Router } from "express";
import { formatInTimeZone } from "date-fns-tz";

import { requireAuth } from "../middleware/requireAuth";
import { createChannexAriOutboxEvent } from "../pms/outbound/channex-ari-outbox.service";

export function buildDashboardChannexFullSyncCertificationRouter(
  prisma: PrismaClient
) {
  const router = Router();

  router.post(
    "/api/dashboard/properties/:id/channex/sync-availability",
    requireAuth,
    async (req, res) => {
      try {
        const user = (req as any).user;
        const orgId = String(user.orgId ?? "").trim();
        const propertyId = String(req.params.id ?? "").trim();

        const property = await prisma.property.findFirst({
          where: {
            id: propertyId,
            organizationId: orgId,
            status: "ACTIVE",
          },
          select: {
            id: true,
            timezone: true,
            distributionEnabled: true,
            distributionStatus: true,
          },
        });

        if (!property) {
          return res.status(404).json({
            ok: false,
            error: "Property not found",
          });
        }

        if (
          property.distributionEnabled !== true ||
          property.distributionStatus !== "ACTIVE"
        ) {
          return res.status(409).json({
            ok: false,
            error:
              "Property distribution must be ACTIVE before requesting a Full Sync",
          });
        }

        const requestedAt = new Date();
        const propertyTimezone =
          property.timezone ?? "America/Puerto_Rico";
        const todayDateKey = formatInTimeZone(
          requestedAt,
          propertyTimezone,
          "yyyy-MM-dd"
        );
        const correlationId =
          `manual-full-sync:${property.id}:${crypto.randomUUID()}`;

        const result = await prisma.$transaction(
          async (tx) => {
            const inFlightFullSync =
              await tx.distributionOutboxEvent.findFirst({
                where: {
                  organizationId: orgId,
                  propertyId: property.id,
                  provider: "CHANNEX",
                  syncMode: "FULL",
                  trigger: "MANUAL_FULL_SYNC",
                  OR: [
                    {
                      status: {
                        in: ["PENDING", "CLAIMED"],
                      },
                    },
                    {
                      status: "MERGED",
                      delivery: {
                        is: {
                          status: {
                            in: ["READY", "PROCESSING", "RETRY_WAIT"],
                          },
                        },
                      },
                    },
                  ],
                },
                select: {
                  id: true,
                  correlationId: true,
                  status: true,
                  deliveryId: true,
                },
              });

            if (inFlightFullSync) {
              const guardError = new Error(
                "CHANNEX_ARI_FULL_SYNC_IN_PROGRESS"
              );
              (guardError as any).correlationId =
                inFlightFullSync.correlationId ?? null;
              throw guardError;
            }

            await createChannexAriOutboxEvent(tx, {
              organizationId: orgId,
              propertyId: property.id,
              messageKind: "AVAILABILITY",
              syncMode: "FULL",
              trigger: "MANUAL_FULL_SYNC",
              sourceEntityType: "PROPERTY",
              sourceEntityId: property.id,
              correlationId,
              todayDateKey,
              now: requestedAt,
              coalesceMs: 0,
            });

            await createChannexAriOutboxEvent(tx, {
              organizationId: orgId,
              propertyId: property.id,
              messageKind: "RATES_RESTRICTIONS",
              syncMode: "FULL",
              trigger: "MANUAL_FULL_SYNC",
              sourceEntityType: "PROPERTY",
              sourceEntityId: property.id,
              correlationId,
              todayDateKey,
              now: requestedAt,
              coalesceMs: 0,
            });

            await tx.channexAriPropertyState.upsert({
              where: { propertyId: property.id },
              create: {
                propertyId: property.id,
                organizationId: orgId,
                lastFullSyncRequestedAt: requestedAt,
              },
              update: {
                lastFullSyncRequestedAt: requestedAt,
              },
            });

            return {
              queued: true,
              syncMode: "FULL",
              correlationId,
              requestedAt,
              messageKinds: [
                "AVAILABILITY",
                "RATES_RESTRICTIONS",
              ],
            };
          },
          {
            isolationLevel:
              Prisma.TransactionIsolationLevel.Serializable,
          }
        );

        return res.json({
          ok: true,
          result,
        });
      } catch (error: any) {
        if (error?.message === "CHANNEX_ARI_FULL_SYNC_IN_PROGRESS") {
          return res.status(409).json({
            ok: false,
            error: "A Full Sync is already in progress for this property",
            correlationId: error?.correlationId ?? null,
          });
        }

        console.error(
          "POST /api/dashboard/properties/:id/channex/sync-availability certification override error",
          error
        );

        return res.status(500).json({
          ok: false,
          error:
            error?.message ??
            "Failed to request Channex Full Sync",
        });
      }
    }
  );

  return router;
}
