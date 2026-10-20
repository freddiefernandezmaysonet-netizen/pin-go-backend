import type { PrismaClient, Prisma } from "@prisma/client";
import { resolveChannexAriMapping } from "../pms/outbound/channex-ari-mapping.service.js";
import { createChannexAriOutboxEvent } from "../pms/outbound/channex-ari-outbox.service.js";
import { formatInTimeZone } from "date-fns-tz";
import { requireIanaTimezone } from "../lib/iana-timezone.js";
import { addUtcDays, CHANNEX_ARI_FULL_SYNC_DAYS } from "../pms/outbound/channex-ari-lifecycle.policy.js";
import {
  buildRateRefreshPlan, readRateRefreshSnapshot, RATE_REFRESH_SOURCE, RATE_REFRESH_TRIGGER,
} from "./rate-refresh.policy.js";

const rateSelect = {
  baseNightlyRate: true, minimumNightlyRate: true, maximumNightlyRate: true,
  dynamicPricingEnabled: true, seasonalPricingEnabled: true, holidayPricingEnabled: true,
  weekendMarkupPercent: true, leadTimePricingEnabled: true, leadTimeLastMinuteDays: true,
  leadTimeLastMinutePercent: true, occupancyPricingEnabled: true, occupancyLookaheadDays: true,
  occupancyLowThresholdPercent: true, occupancyLowAdjustmentPercent: true,
  occupancyHighThresholdPercent: true, occupancyHighAdjustmentPercent: true,
} as const;

export type RateRefreshTx = Pick<Prisma.TransactionClient,
  "property" | "reservation" | "pmsConnection" | "pmsListing" | "distributionOutboxEvent" | "$queryRaw">;
export type RateRefreshDb = Pick<PrismaClient, "property" | "$transaction">;
export type RateRefreshDependencies = {
  resolveMapping: typeof resolveChannexAriMapping;
  createEvent: typeof createChannexAriOutboxEvent;
};
const defaultDependencies: RateRefreshDependencies = {
  resolveMapping: resolveChannexAriMapping, createEvent: createChannexAriOutboxEvent,
};

export async function refreshPropertyRates(tx: RateRefreshTx, scope: {
  propertyId: string; organizationId: string;
}, now: Date, dependencies: RateRefreshDependencies = defaultDependencies) {
  const lease = await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_xact_lock(hashtextextended(
      ${`distribution-rate-refresh:v1:${scope.propertyId}`}, 0)) AS locked`;
  if (lease[0]?.locked !== true) return { status: "BUSY", enqueued: 0 } as const;

  const property = await tx.property.findFirst({ where: {
    id: scope.propertyId, organizationId: scope.organizationId,
    status: "ACTIVE", distributionEnabled: true, distributionStatus: "ACTIVE",
  }, select: { id: true, organizationId: true, timezone: true, ...rateSelect } });
  if (!property) return { status: "INELIGIBLE", enqueued: 0 } as const;
  // Reuse certified tenant/provider/mapping validation. The producer never
  // calls Channex and never substitutes another property's mapping.
  await dependencies.resolveMapping(tx, scope);
  const day = formatInTimeZone(now, requireIanaTimezone(property.timezone), "yyyy-MM-dd");
  const horizonStart = new Date(`${day}T00:00:00.000Z`);
  const horizonEnd = new Date(`${addUtcDays(day, CHANNEX_ARI_FULL_SYNC_DAYS)}T00:00:00.000Z`);
  const reservations = property.dynamicPricingEnabled && property.occupancyPricingEnabled
    ? await tx.reservation.findMany({ where: {
      propertyId: property.id, status: "ACTIVE",
      checkIn: { lt: horizonEnd }, checkOut: { gt: horizonStart },
    }, select: { checkIn: true, checkOut: true } }) : [];
  const prior = await tx.distributionOutboxEvent.findFirst({ where: {
    organizationId: property.organizationId, propertyId: property.id, provider: "CHANNEX",
    trigger: RATE_REFRESH_TRIGGER, sourceEntityType: RATE_REFRESH_SOURCE,
    messageKind: "RATES_RESTRICTIONS",
  }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { sourceEntityId: true } });
  const rateConfiguration = Object.fromEntries(Object.keys(rateSelect).map(key =>
    [key, property[key as keyof typeof rateSelect]]));
  const plan = buildRateRefreshPlan({ property, rateConfiguration, reservations,
    previous: readRateRefreshSnapshot(prior?.sourceEntityId ?? null), now });
  if (!plan.changed) return { status: "UNCHANGED", enqueued: 0 } as const;

  let enqueued = 0;
  const common = {
    organizationId: property.organizationId, propertyId: property.id,
    trigger: RATE_REFRESH_TRIGGER, sourceEntityType: RATE_REFRESH_SOURCE,
    sourceEntityId: plan.sourceEntityId, now,
  };
  if (plan.availabilityRange) {
    await dependencies.createEvent(tx, { ...common, messageKind: "AVAILABILITY", dateRange: {
      from: plan.availabilityRange.dateFrom, toExclusive: plan.availabilityRange.dateToExclusive,
    } });
    enqueued++;
  }
  await dependencies.createEvent(tx, { ...common, messageKind: "RATES_RESTRICTIONS",
    dateRange: { from: plan.rateRange.dateFrom, toExclusive: plan.rateRange.dateToExclusive }, changedFields: plan.rateFields });
  return { status: "ENQUEUED", enqueued: enqueued + 1 } as const;
}

function publicErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z0-9_]{1,128}$/.test(message) ? message : "DISTRIBUTION_RATE_REFRESH_FAILED";
}

export async function runRateRefreshCycle(db: RateRefreshDb, now = new Date()) {
  const result = { checked: 0, enqueued: 0, failed: 0, busy: 0,
    failures: [] as Array<{ propertyId: string; code: string }> };
  let cursor: string | undefined;
  // Keyset pages visit all eligible properties; a failing property cannot
  // monopolize a top-N batch. Recheck eligibility inside each transaction.
  while (true) {
    const properties = await db.property.findMany({ where: {
      status: "ACTIVE", distributionEnabled: true, distributionStatus: "ACTIVE",
    }, select: { id: true, organizationId: true }, orderBy: { id: "asc" }, take: 100,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const property of properties) {
      result.checked++;
      try {
        const outcome = await runPropertyTransaction(db, property, now);
        result.enqueued += outcome.enqueued;
        if (outcome.status === "BUSY") result.busy++;
      } catch (error) {
        result.failed++;
        result.failures.push({ propertyId: property.id, code: publicErrorCode(error) });
      }
    }
    if (properties.length < 100) break;
    cursor = properties.at(-1)!.id;
  }
  return result;
}

async function runPropertyTransaction(db: RateRefreshDb, property: { id: string; organizationId: string }, now: Date) {
  for (let attempt = 0; ; attempt++) {
    try {
      // Serializable also protects the read-before-lock snapshot race between
      // competing workers. Retry only a transaction known to have rolled back.
      return await db.$transaction(tx => refreshPropertyRates(tx, {
        propertyId: property.id, organizationId: property.organizationId,
      }, now), { isolationLevel: "Serializable", maxWait: 5000, timeout: 20000 });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (attempt >= 2 || (code !== "P2034" && code !== "40001")) throw error;
    }
  }
}
