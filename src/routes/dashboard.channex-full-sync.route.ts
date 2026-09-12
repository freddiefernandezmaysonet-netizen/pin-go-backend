import crypto from "crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { Router } from "express";
import { formatInTimeZone } from "date-fns-tz";

import { requireIanaTimezone } from "../lib/iana-timezone";
import { requireAuth } from "../middleware/requireAuth";
import {
  resolveChannexAriMapping,
  type ChannexAriMappingDb,
} from "../pms/outbound/channex-ari-mapping.service";
import { createChannexAriOutboxEvent } from "../pms/outbound/channex-ari-outbox.service";
import { buildDashboardCalendarOverridesRouter } from "./dashboard.calendar-overrides.route";

const CHANNEX_PRODUCTION_ORIGIN = "https://app.channex.io";

type CanonicalFullSyncMapping = {
  organizationId: unknown;
  propertyId: unknown;
  platform: unknown;
  provisioningStatus: unknown;
  externalPropertyId: unknown;
  externalPrimaryRoomTypeId: unknown;
  externalPrimaryRatePlanId: unknown;
} | null;

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function assertFullSyncProductionChannexHost(
  env: NodeJS.ProcessEnv = process.env
): void {
  if (normalizedText(env.NODE_ENV).toLowerCase() !== "production") return;

  const configured = normalizedText(env.CHANNEX_API_BASE_URL);
  let parsed: URL;

  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("CHANNEX_ARI_PRODUCTION_HOST_INVALID");
  }

  if (
    parsed.origin !== CHANNEX_PRODUCTION_ORIGIN ||
    parsed.pathname !== "/" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("CHANNEX_ARI_PRODUCTION_HOST_INVALID");
  }
}

export function assertFullSyncCanonicalMappingConsistency(input: {
  organizationId: string;
  propertyId: string;
  legacyMapping: {
    channexPropertyId: string;
    externalRoomTypeId: string;
    channexRatePlanId: string;
  };
  canonicalMapping: CanonicalFullSyncMapping;
}): void {
  const canonical = input.canonicalMapping;
  if (!canonical) {
    throw new Error("CHANNEX_ARI_CANONICAL_MAPPING_MISSING");
  }

  if (
    normalizedText(canonical.organizationId) !== input.organizationId ||
    normalizedText(canonical.propertyId) !== input.propertyId ||
    normalizedText(canonical.platform) !== "CHANNEX" ||
    normalizedText(canonical.provisioningStatus) !== "READY"
  ) {
    throw new Error("CHANNEX_ARI_CANONICAL_MAPPING_NOT_READY");
  }

  if (
    normalizedText(canonical.externalPropertyId) !==
      input.legacyMapping.channexPropertyId ||
    normalizedText(canonical.externalPrimaryRoomTypeId) !==
      input.legacyMapping.externalRoomTypeId ||
    normalizedText(canonical.externalPrimaryRatePlanId) !==
      input.legacyMapping.channexRatePlanId
  ) {
    throw new Error("CHANNEX_ARI_CANONICAL_MAPPING_MISMATCH");
  }
}

export function resolveFullSyncTodayDateKey(
  requestedAt: Date,
  propertyTimezone: unknown
): string {
  const timezone = requireIanaTimezone(propertyTimezone);
  return formatInTimeZone(requestedAt, timezone, "yyyy-MM-dd");
}

export function buildDashboardChannexFullSyncRouter(prisma: PrismaClient) {
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

        assertFullSyncProductionChannexHost();

        const requestedAt = new Date();
        const todayDateKey = resolveFullSyncTodayDateKey(
          requestedAt,
          property.timezone
        );
        const correlationId =
          `manual-full-sync:${property.id}:${crypto.randomUUID()}`;

        const result = await prisma.$transaction(
          async (tx) => {
            const legacyMapping = await resolveChannexAriMapping(
              tx as ChannexAriMappingDb,
              {
                organizationId: orgId,
                propertyId: property.id,
              }
            );
            const canonicalMapping =
              await tx.distributionProperty.findUnique({
                where: {
                  propertyId_platform: {
                    propertyId: property.id,
                    platform: "CHANNEX",
                  },
                },
                select: {
                  organizationId: true,
                  propertyId: true,
                  platform: true,
                  provisioningStatus: true,
                  externalPropertyId: true,
                  externalPrimaryRoomTypeId: true,
                  externalPrimaryRatePlanId: true,
                },
              });

            assertFullSyncCanonicalMappingConsistency({
              organizationId: orgId,
              propertyId: property.id,
              legacyMapping,
              canonicalMapping,
            });

            const existingAriState =
              await tx.channexAriPropertyState.findUnique({
                where: { propertyId: property.id },
                select: {
                  organizationId: true,
                },
              });

            if (
              existingAriState &&
              existingAriState.organizationId !== orgId
            ) {
              throw new Error(
                "CHANNEX_ARI_PROPERTY_STATE_TENANT_MISMATCH"
              );
            }

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
                  correlationId: true,
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

        if (
          error?.message === "CHANNEX_ARI_PRODUCTION_HOST_INVALID" ||
          error?.message === "CHANNEX_ARI_CANONICAL_MAPPING_MISSING" ||
          error?.message === "CHANNEX_ARI_CANONICAL_MAPPING_NOT_READY" ||
          error?.message === "CHANNEX_ARI_CANONICAL_MAPPING_MISMATCH"
        ) {
          return res.status(409).json({
            ok: false,
            error:
              error.message === "CHANNEX_ARI_PRODUCTION_HOST_INVALID"
                ? "Production Full Sync requires https://app.channex.io"
                : "Canonical Channex mapping is not aligned for Full Sync",
            code: error.message,
          });
        }

        if (
          error?.message === "PROPERTY_TIMEZONE_REQUIRED" ||
          error?.message === "PROPERTY_TIMEZONE_INVALID"
        ) {
          return res.status(409).json({
            ok: false,
            error: error.message,
          });
        }

        console.error(
          "POST /api/dashboard/properties/:id/channex/sync-availability error",
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

  router.use(buildDashboardCalendarOverridesRouter(prisma));

  return router;
}
