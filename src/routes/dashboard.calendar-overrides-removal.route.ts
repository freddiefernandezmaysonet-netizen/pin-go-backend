import type { Router } from "express";
import { Prisma, type PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { CHANNEX_ARI_FULL_SYNC_DAYS } from "../pms/outbound/channex-ari-lifecycle.policy";
import { createChannexAriOutboxEvent } from "../pms/outbound/channex-ari-outbox.service";
import type { ChannexAriRatesRestrictionsChangedField } from "../pms/outbound/channex-ari-rates-restrictions-snapshot.policy";

type RestrictionField = "minimumNights" | "maximumNights";
const FIELDS: RestrictionField[] = ["minimumNights", "maximumNights"];
const DAY_MS = 86_400_000;

class RemovalError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function parseRemoval(body: unknown): { dates: Date[]; fields: RestrictionField[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RemovalError(400, "Select dates and restrictions to remove.");
  }
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "dateKeys" && key !== "fields")) {
    throw new RemovalError(400, "Only dateKeys and fields are accepted. Rates cannot be removed here.");
  }
  if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > 2 ||
      new Set(input.fields).size !== input.fields.length ||
      input.fields.some((field) => !FIELDS.includes(field as RestrictionField))) {
    throw new RemovalError(400, "Choose minimumNights, maximumNights, or both.");
  }
  if (!Array.isArray(input.dateKeys) || input.dateKeys.length < 1 ||
      input.dateKeys.length > CHANNEX_ARI_FULL_SYNC_DAYS) {
    throw new RemovalError(400, `Select between 1 and ${CHANNEX_ARI_FULL_SYNC_DAYS} dates.`);
  }
  const seen = new Set<string>();
  const dates = input.dateKeys.map((key: unknown) => {
    if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) {
      throw new RemovalError(400, "Each date must use YYYY-MM-DD.");
    }
    const date = new Date(`${key}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== key || seen.has(key)) {
      throw new RemovalError(400, "Dates must be valid and must not be duplicated.");
    }
    seen.add(key);
    return date;
  }).sort((left, right) => left.getTime() - right.getTime());
  if ((dates.at(-1)!.getTime() - dates[0].getTime()) / DAY_MS + 1 > CHANNEX_ARI_FULL_SYNC_DAYS) {
    throw new RemovalError(400, `The selected range cannot exceed ${CHANNEX_ARI_FULL_SYNC_DAYS} days.`);
  }
  return { dates, fields: FIELDS.filter((field) => (input.fields as unknown[]).includes(field)) };
}

/** Remove date-specific manual stay limits; never modify nightly rates or bookings. */
export function registerCalendarOverrideRemoval(router: Router, prisma: PrismaClient): void {
  router.delete("/api/dashboard/properties/:id/calendar-overrides", requireAuth, async (req, res) => {
    try {
      const organizationId = String((req as any).user?.orgId ?? "").trim();
      const propertyId = String(req.params.id ?? "").trim();
      if (!organizationId) return res.status(403).json({ ok: false, error: "Organization access is required." });
      if (!propertyId) return res.status(400).json({ ok: false, error: "Property is required." });
      const { dates, fields } = parseRemoval(req.body);
      const result = await prisma.$transaction(async (tx) => {
        const property = await tx.property.findFirst({
          where: { id: propertyId, organizationId, status: "ACTIVE" },
          select: { id: true, minimumNights: true, maximumNights: true, distributionEnabled: true, distributionStatus: true },
        });
        if (!property) throw new RemovalError(404, "Property not found");
        const rows = await tx.propertyNightlyRestriction.findMany({
          where: { propertyId, date: { in: dates } },
          select: { date: true, minimumNights: true, maximumNights: true, source: true },
          orderBy: { date: "asc" },
        });
        const changes = rows.flatMap((row) => {
          const removedFields = fields.filter((field) => row[field] !== null);
          if (removedFields.length === 0) return [];
          if (row.source !== "MANUAL") throw new RemovalError(409, "Only manual stay restrictions can be removed here.");
          const minimumNights = fields.includes("minimumNights") ? null : row.minimumNights;
          const maximumNights = fields.includes("maximumNights") ? null : row.maximumNights;
          const effectiveMinimumNights = minimumNights ?? property.minimumNights;
          const effectiveMaximumNights = maximumNights ?? property.maximumNights;
          if (effectiveMaximumNights !== null && effectiveMaximumNights < effectiveMinimumNights) {
            throw new RemovalError(409, `Removing this restriction would make the maximum lower than the minimum for ${row.date.toISOString().slice(0, 10)}. Remove both restrictions or adjust the remaining limit first.`);
          }
          return [{ ...row, minimumNights, maximumNights, removedFields, effectiveMinimumNights, effectiveMaximumNights }];
        });
        const changedFields = new Set<ChannexAriRatesRestrictionsChangedField>();
        for (const change of changes) {
          const where = { propertyId_date: { propertyId, date: change.date } };
          if (change.minimumNights === null && change.maximumNights === null) {
            await tx.propertyNightlyRestriction.delete({ where });
          } else {
            const data: { minimumNights?: null; maximumNights?: null } = {};
            for (const field of change.removedFields) data[field] = null;
            await tx.propertyNightlyRestriction.update({ where, data });
          }
          if (change.removedFields.includes("minimumNights")) {
            changedFields.add("minStayArrival");
            changedFields.add("minStayThrough");
          }
          if (change.removedFields.includes("maximumNights")) changedFields.add("maxStay");
        }
        const syncQueued = changes.length > 0 && property.distributionEnabled === true && property.distributionStatus === "ACTIVE";
        if (syncQueued) {
          await createChannexAriOutboxEvent(tx, {
            organizationId, propertyId, messageKind: "RATES_RESTRICTIONS", trigger: "CALENDAR_RESTRICTION_REMOVE",
            syncMode: "INCREMENTAL", dateKeys: changes.map((change) => change.date.toISOString().slice(0, 10)),
            changedFields: Array.from(changedFields), sourceEntityType: "PROPERTY", sourceEntityId: propertyId, now: new Date(),
          });
        }
        return {
          affectedDates: changes.length,
          overrides: changes.map((change) => ({
            date: change.date.toISOString().slice(0, 10), removedFields: change.removedFields,
            effectiveMinimumNights: change.effectiveMinimumNights, effectiveMaximumNights: change.effectiveMaximumNights,
          })),
          changedFields: Array.from(changedFields), syncQueued,
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return res.json({ ok: true, ...result });
    } catch (error: unknown) {
      if (error instanceof RemovalError) return res.status(error.status).json({ ok: false, error: error.message });
      if (error && typeof error === "object" && "code" in error && error.code === "P2034") {
        return res.status(409).json({ ok: false, error: "Restrictions changed concurrently. Review the dates and retry." });
      }
      console.error("DELETE calendar-overrides failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
      return res.status(500).json({ ok: false, error: "Failed to remove stay restrictions. No changes were saved." });
    }
  });
}
