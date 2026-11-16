import type { Router } from "express";
import { Prisma, type PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { CHANNEX_ARI_FULL_SYNC_DAYS } from "../pms/outbound/channex-ari-lifecycle.policy";
import { createChannexAriOutboxEvent } from "../pms/outbound/channex-ari-outbox.service";

const DAY_MS = 86_400_000;

class RemovalError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function parseRemoval(body: unknown): Date[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RemovalError(400, "Select dates to restore automatic pricing.");
  }
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "dateKeys")) {
    throw new RemovalError(400, "Only dateKeys is accepted.");
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
  return dates;
}

export function registerNightlyRateRemoval(router: Router, prisma: PrismaClient): void {
  router.delete("/api/dashboard/properties/:id/nightly-rates", requireAuth, async (req, res) => {
    try {
      const organizationId = String((req as any).user?.orgId ?? "").trim();
      const propertyId = String(req.params.id ?? "").trim();
      if (!organizationId) return res.status(403).json({ ok: false, error: "Organization access is required." });
      if (!propertyId) return res.status(400).json({ ok: false, error: "Property is required." });
      const dates = parseRemoval(req.body);
      const result = await prisma.$transaction(async tx => {
        const property = await tx.property.findFirst({
          where: { id: propertyId, organizationId, status: "ACTIVE" },
          select: { id: true, baseNightlyRate: true, dynamicPricingEnabled: true, distributionEnabled: true, distributionStatus: true },
        });
        if (!property) throw new RemovalError(404, "Property not found");
        const rows = await tx.propertyNightlyRate.findMany({ where: { propertyId, date: { in: dates } }, select: { date: true }, orderBy: { date: "asc" } });
        const changedDates = rows.map(row => row.date);
        if (changedDates.length && (!property.baseNightlyRate || Number(property.baseNightlyRate) <= 0)) {
          throw new RemovalError(409, "Set a positive base nightly rate before restoring automatic pricing.");
        }
        if (changedDates.length) await tx.propertyNightlyRate.deleteMany({ where: { propertyId, date: { in: changedDates } } });
        const syncQueued = changedDates.length > 0 && property.distributionEnabled === true && property.distributionStatus === "ACTIVE";
        if (syncQueued) await createChannexAriOutboxEvent(tx, {
          organizationId, propertyId, messageKind: "RATES_RESTRICTIONS", trigger: "NIGHTLY_RATE_REMOVE",
          syncMode: "INCREMENTAL", dateKeys: changedDates.map(date => date.toISOString().slice(0, 10)), changedFields: ["rate"],
          sourceEntityType: "PROPERTY", sourceEntityId: propertyId, now: new Date(),
        });
        return { affectedDates: changedDates.length, dateKeys: changedDates.map(date => date.toISOString().slice(0, 10)),
          dynamicPricingEnabled: property.dynamicPricingEnabled, syncQueued };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return res.json({ ok: true, ...result });
    } catch (error: unknown) {
      if (error instanceof RemovalError) return res.status(error.status).json({ ok: false, error: error.message });
      if (error && typeof error === "object" && "code" in error && error.code === "P2034") {
        return res.status(409).json({ ok: false, error: "Prices changed concurrently. Review the dates and retry." });
      }
      console.error("DELETE nightly-rates failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
      return res.status(500).json({ ok: false, error: "Failed to restore automatic pricing. No changes were saved." });
    }
  });
}
