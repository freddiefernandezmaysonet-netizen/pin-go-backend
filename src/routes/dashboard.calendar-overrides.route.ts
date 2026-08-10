import { Router } from "express";
import { PrismaClient } from "@prisma/client";

import { requireAuth } from "../middleware/requireAuth";
import { createChannexAriOutboxEvent } from "../pms/outbound/channex-ari-outbox.service";
import type { ChannexAriRatesRestrictionsChangedField } from "../pms/outbound/channex-ari-rates-restrictions-snapshot.policy";

const prisma = new PrismaClient();

export const dashboardCalendarOverridesRouter = Router();

type NormalizedCalendarOverride = {
  dateKey: string;
  date: Date;
  hasRate: boolean;
  rate: number | null;
  hasMinimumNights: boolean;
  minimumNights: number | null;
  hasMaximumNights: boolean;
  maximumNights: number | null;
  reason: string;
};

function hasOwn(value: unknown, key: string): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      Object.prototype.hasOwnProperty.call(value, key)
  );
}

function parseDateKey(value: unknown): { dateKey: string; date: Date } | null {
  const dateKey = String(value ?? "").trim();
  const date = new Date(`${dateKey}T00:00:00.000Z`);

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(dateKey) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== dateKey
  ) {
    return null;
  }

  return { dateKey, date };
}

function parsePositiveInteger(value: unknown): number | null {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

function calendarOverrideShape(input: {
  hasRate: boolean;
  hasMinimumNights: boolean;
  hasMaximumNights: boolean;
}): string {
  return [
    input.hasRate ? "rate" : "",
    input.hasMinimumNights ? "minimumNights" : "",
    input.hasMaximumNights ? "maximumNights" : "",
  ]
    .filter(Boolean)
    .join("|");
}

dashboardCalendarOverridesRouter.put(
  "/api/dashboard/properties/:id/calendar-overrides",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const organizationId = String(user.orgId ?? "").trim();
      const propertyId = String(req.params.id ?? "").trim();
      const overrides = Array.isArray(req.body?.overrides)
        ? req.body.overrides
        : [];

      if (!overrides.length) {
        return res.status(400).json({
          ok: false,
          error: "overrides must be a non-empty array",
        });
      }

      const property = await prisma.property.findFirst({
        where: {
          id: propertyId,
          organizationId,
          status: "ACTIVE",
        },
        select: {
          id: true,
          distributionEnabled: true,
          distributionStatus: true,
          minimumNightlyRate: true,
          maximumNightlyRate: true,
          minimumNights: true,
          maximumNights: true,
        },
      });

      if (!property) {
        return res.status(404).json({
          ok: false,
          error: "Property not found",
        });
      }

      const minimumNightlyRate =
        property.minimumNightlyRate == null
          ? null
          : Number(property.minimumNightlyRate);
      const maximumNightlyRate =
        property.maximumNightlyRate == null
          ? null
          : Number(property.maximumNightlyRate);
      const normalized: NormalizedCalendarOverride[] = [];
      const seenDateKeys = new Set<string>();
      const changedFields = new Set<ChannexAriRatesRestrictionsChangedField>();
      let expectedShape: string | null = null;

      for (const rawItem of overrides) {
        const parsedDate = parseDateKey(rawItem?.date);

        if (!parsedDate) {
          return res.status(400).json({
            ok: false,
            error: "Each override must include a valid YYYY-MM-DD date",
          });
        }

        if (seenDateKeys.has(parsedDate.dateKey)) {
          return res.status(400).json({
            ok: false,
            error: `Duplicate calendar override date: ${parsedDate.dateKey}`,
          });
        }
        seenDateKeys.add(parsedDate.dateKey);

        const hasRate = hasOwn(rawItem, "rate");
        const hasMinimumNights = hasOwn(rawItem, "minimumNights");
        const hasMaximumNights = hasOwn(rawItem, "maximumNights");

        if (!hasRate && !hasMinimumNights && !hasMaximumNights) {
          return res.status(400).json({
            ok: false,
            error:
              "Each override must include rate, minimumNights, maximumNights, or a combination",
          });
        }

        const currentShape = calendarOverrideShape({
          hasRate,
          hasMinimumNights,
          hasMaximumNights,
        });

        if (expectedShape === null) {
          expectedShape = currentShape;
        } else if (currentShape !== expectedShape) {
          return res.status(400).json({
            ok: false,
            error:
              "All calendar overrides in one operation must include the same fields",
          });
        }

        let rate: number | null = null;
        let minimumNights: number | null = null;
        let maximumNights: number | null = null;

        if (hasRate) {
          rate = Number(rawItem.rate);

          if (!Number.isFinite(rate) || rate <= 0) {
            return res.status(400).json({
              ok: false,
              error: `Invalid rate for ${parsedDate.dateKey}`,
            });
          }

          if (minimumNightlyRate !== null && rate < minimumNightlyRate) {
            return res.status(400).json({
              ok: false,
              error: `Rate cannot be lower than minimumNightlyRate (${minimumNightlyRate})`,
            });
          }

          if (maximumNightlyRate !== null && rate > maximumNightlyRate) {
            return res.status(400).json({
              ok: false,
              error: `Rate cannot be greater than maximumNightlyRate (${maximumNightlyRate})`,
            });
          }

          changedFields.add("rate");
        }

        if (hasMinimumNights) {
          minimumNights = parsePositiveInteger(rawItem.minimumNights);

          if (minimumNights === null) {
            return res.status(400).json({
              ok: false,
              error: `minimumNights must be an integer greater than or equal to 1 for ${parsedDate.dateKey}`,
            });
          }

          changedFields.add("minStayArrival");
          changedFields.add("minStayThrough");
        }

        if (hasMaximumNights) {
          maximumNights = parsePositiveInteger(rawItem.maximumNights);

          if (maximumNights === null) {
            return res.status(400).json({
              ok: false,
              error: `maximumNights must be an integer greater than or equal to 1 for ${parsedDate.dateKey}`,
            });
          }

          changedFields.add("maxStay");
        }

        normalized.push({
          dateKey: parsedDate.dateKey,
          date: parsedDate.date,
          hasRate,
          rate,
          hasMinimumNights,
          minimumNights,
          hasMaximumNights,
          maximumNights,
          reason:
            String(rawItem?.reason ?? "CALENDAR_OVERRIDE").trim() ||
            "CALENDAR_OVERRIDE",
        });
      }

      const mutationAt = new Date();
      const saved = await prisma.$transaction(async (tx) => {
        const existingRestrictions = await tx.propertyNightlyRestriction.findMany({
          where: {
            propertyId,
            date: { in: normalized.map((item) => item.date) },
          },
          select: {
            date: true,
            minimumNights: true,
            maximumNights: true,
          },
        });
        const existingRestrictionByDate = new Map(
          existingRestrictions.map((item) => [
            item.date.toISOString().slice(0, 10),
            item,
          ])
        );

        for (const item of normalized) {
          if (item.hasMinimumNights || item.hasMaximumNights) {
            const existingRestriction = existingRestrictionByDate.get(item.dateKey);
            const effectiveMinimumNights = item.hasMinimumNights
              ? item.minimumNights!
              : existingRestriction?.minimumNights ?? property.minimumNights;
            const effectiveMaximumNights = item.hasMaximumNights
              ? item.maximumNights!
              : existingRestriction?.maximumNights ?? property.maximumNights;

            if (
              effectiveMaximumNights != null &&
              effectiveMaximumNights < effectiveMinimumNights
            ) {
              throw new Error(
                `CALENDAR_OVERRIDE_MAXIMUM_BELOW_MINIMUM:${item.dateKey}`
              );
            }
          }
        }

        const persisted: Array<{
          date: string;
          rate?: number;
          minimumNights?: number;
          maximumNights?: number;
        }> = [];

        for (const item of normalized) {
          const result: {
            date: string;
            rate?: number;
            minimumNights?: number;
            maximumNights?: number;
          } = { date: item.dateKey };

          if (item.hasRate) {
            const savedRate = await tx.propertyNightlyRate.upsert({
              where: {
                propertyId_date: {
                  propertyId,
                  date: item.date,
                },
              },
              update: {
                rate: item.rate!,
                reason: item.reason,
              },
              create: {
                propertyId,
                date: item.date,
                rate: item.rate!,
                reason: item.reason,
              },
              select: {
                rate: true,
              },
            });

            result.rate = Number(savedRate.rate);
          }

          if (item.hasMinimumNights || item.hasMaximumNights) {
            const restrictionUpdate: {
              minimumNights?: number;
              maximumNights?: number;
              source: string;
              reason: string;
            } = {
              source: "MANUAL",
              reason: item.reason,
            };
            const restrictionCreate = {
              propertyId,
              date: item.date,
              minimumNights: item.hasMinimumNights ? item.minimumNights : null,
              maximumNights: item.hasMaximumNights ? item.maximumNights : null,
              source: "MANUAL",
              reason: item.reason,
            };

            if (item.hasMinimumNights) {
              restrictionUpdate.minimumNights = item.minimumNights!;
            }
            if (item.hasMaximumNights) {
              restrictionUpdate.maximumNights = item.maximumNights!;
            }

            const savedRestriction = await tx.propertyNightlyRestriction.upsert({
              where: {
                propertyId_date: {
                  propertyId,
                  date: item.date,
                },
              },
              update: restrictionUpdate,
              create: restrictionCreate,
              select: {
                minimumNights: true,
                maximumNights: true,
              },
            });

            if (savedRestriction.minimumNights != null) {
              result.minimumNights = savedRestriction.minimumNights;
            }
            if (savedRestriction.maximumNights != null) {
              result.maximumNights = savedRestriction.maximumNights;
            }
          }

          persisted.push(result);
        }

        if (
          property.distributionEnabled === true &&
          property.distributionStatus === "ACTIVE"
        ) {
          await createChannexAriOutboxEvent(tx, {
            organizationId,
            propertyId,
            messageKind: "RATES_RESTRICTIONS",
            trigger: "CALENDAR_OVERRIDE_UPDATE",
            syncMode: "INCREMENTAL",
            dateKeys: normalized.map((item) => item.dateKey),
            changedFields: Array.from(changedFields),
            sourceEntityType: "PROPERTY",
            sourceEntityId: propertyId,
            now: mutationAt,
          });
        }

        return persisted;
      });

      return res.json({
        ok: true,
        overrides: saved,
        changedFields: Array.from(changedFields),
      });
    } catch (error: any) {
      if (
        typeof error?.message === "string" &&
        error.message.startsWith("CALENDAR_OVERRIDE_MAXIMUM_BELOW_MINIMUM:")
      ) {
        const dateKey = error.message.split(":")[1] ?? "selected date";
        return res.status(400).json({
          ok: false,
          error: `maximumNights cannot be lower than minimumNights for ${dateKey}`,
        });
      }

      console.error("PUT calendar-overrides error", error);
      return res.status(500).json({
        ok: false,
        error: "Failed to save calendar overrides",
      });
    }
  }
);
