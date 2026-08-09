import type { Prisma } from "@prisma/client";

import { calculateDirectBookingPricing } from "../../services/direct-booking-pricing.service";
import {
  buildChannexAriAvailabilitySnapshot,
  type ChannexAriAvailabilityRange,
} from "./channex-ari-availability-snapshot.policy";
import type { ChannexAriCoalescingPlan } from "./channex-ari-coalescing.policy";
import type {
  ChannexAriDeliveryMapping,
  ChannexAriDeliverySnapshot,
} from "./channex-ari-delivery.service";
import {
  CHANNEX_ARI_FULL_SYNC_DAYS,
  addUtcDays,
  assertDateKey,
  countRangeDays,
  normalizeDateKeys,
} from "./channex-ari-lifecycle.policy";
import {
  buildChannexAriRatesRestrictionsSnapshot,
  type ChannexAriRatesRestrictionsChangedField,
  type ChannexAriRate,
} from "./channex-ari-rates-restrictions-snapshot.policy";

export type ChannexAriSnapshotDb = Pick<
  Prisma.TransactionClient,
  "property" | "reservation" | "propertyBlockedDate"
>;

export type ReadChannexAriSnapshotInput = {
  plan: ChannexAriCoalescingPlan;
  mapping: ChannexAriDeliveryMapping;
  calculatePricing?: typeof calculateDirectBookingPricing;
};

function requireText(value: unknown, errorCode: string): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(errorCode);
  }

  return normalized;
}

function toDatabaseDate(dateKey: string): Date {
  return new Date(`${assertDateKey(dateKey)}T00:00:00.000Z`);
}

function sameStringArray(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function resolvePlanDateKeys(plan: ChannexAriCoalescingPlan): string[] {
  const dateFrom = assertDateKey(plan.dateFrom, "date_from");
  const dateToExclusive = assertDateKey(
    plan.dateToExclusive,
    "date_to_exclusive"
  );
  const dayCount = countRangeDays({ from: dateFrom, toExclusive: dateToExclusive });

  if (dayCount > CHANNEX_ARI_FULL_SYNC_DAYS) {
    throw new Error("CHANNEX_ARI_SNAPSHOT_SCOPE_EXCEEDS_HORIZON");
  }

  if (plan.syncMode === "FULL") {
    if (
      plan.scope !== "FULL_HORIZON" ||
      dayCount !== CHANNEX_ARI_FULL_SYNC_DAYS ||
      plan.dateKeys.length > 0
    ) {
      throw new Error("CHANNEX_ARI_SNAPSHOT_FULL_PLAN_INVALID");
    }

    return Array.from({ length: dayCount }, (_, index) =>
      addUtcDays(dateFrom, index)
    );
  }

  if (plan.syncMode !== "INCREMENTAL") {
    throw new Error("CHANNEX_ARI_SNAPSHOT_SYNC_MODE_INVALID");
  }

  if (plan.scope === "DATE_RANGE") {
    if (plan.dateKeys.length > 0) {
      throw new Error("CHANNEX_ARI_SNAPSHOT_DATE_RANGE_KEYS_NOT_ALLOWED");
    }

    return Array.from({ length: dayCount }, (_, index) =>
      addUtcDays(dateFrom, index)
    );
  }

  if (plan.scope !== "EXACT_DATES") {
    throw new Error("CHANNEX_ARI_SNAPSHOT_INCREMENTAL_SCOPE_INVALID");
  }

  const dateKeys = normalizeDateKeys(plan.dateKeys ?? []);

  if (dateKeys.length === 0) {
    throw new Error("CHANNEX_ARI_SNAPSHOT_DATE_KEYS_REQUIRED");
  }

  if (!sameStringArray(dateKeys, plan.dateKeys)) {
    throw new Error("CHANNEX_ARI_SNAPSHOT_DATE_KEYS_NOT_CANONICAL");
  }

  if (
    dateKeys[0] !== dateFrom ||
    addUtcDays(dateKeys[dateKeys.length - 1], 1) !== dateToExclusive
  ) {
    throw new Error("CHANNEX_ARI_SNAPSHOT_DATE_BOUNDS_MISMATCH");
  }

  return dateKeys;
}

function assertPlanMappingAlignment(input: {
  plan: ChannexAriCoalescingPlan;
  mapping: ChannexAriDeliveryMapping;
}): void {
  if (
    requireText(
      input.mapping.propertyOrganizationId,
      "CHANNEX_ARI_SNAPSHOT_MAPPING_ORGANIZATION_REQUIRED"
    ) !== input.plan.organizationId ||
    requireText(
      input.mapping.connectionOrganizationId,
      "CHANNEX_ARI_SNAPSHOT_CONNECTION_ORGANIZATION_REQUIRED"
    ) !== input.plan.organizationId
  ) {
    throw new Error("CHANNEX_ARI_SNAPSHOT_ORGANIZATION_MISMATCH");
  }

  if (
    requireText(
      input.mapping.propertyId,
      "CHANNEX_ARI_SNAPSHOT_MAPPING_PROPERTY_REQUIRED"
    ) !== input.plan.propertyId
  ) {
    throw new Error("CHANNEX_ARI_SNAPSHOT_PROPERTY_MISMATCH");
  }
}

function resolveRatesRestrictionsChangedFields(
  plan: ChannexAriCoalescingPlan
): ChannexAriRatesRestrictionsChangedField[] | undefined {
  const changedFields = (
    plan as ChannexAriCoalescingPlan & {
      changedFields?: ChannexAriRatesRestrictionsChangedField[];
    }
  ).changedFields;

  if (plan.syncMode === "FULL") {
    if (changedFields !== undefined) {
      throw new Error("CHANNEX_ARI_SNAPSHOT_FULL_CHANGED_FIELDS_NOT_ALLOWED");
    }

    return undefined;
  }

  return changedFields;
}

function normalizeRevenueRate(value: unknown, dateKey: string): ChannexAriRate {
  let majorUnits: number;

  if (typeof value === "string") {
    const normalized = value.trim();

    if (!/^\d+(?:\.\d+)?$/.test(normalized) || !/[1-9]/.test(normalized)) {
      throw new Error(`CHANNEX_ARI_REVENUE_RATE_INVALID:${dateKey}`);
    }

    majorUnits = Number(normalized);
  } else if (typeof value === "number") {
    majorUnits = value;
  } else {
    throw new Error(`CHANNEX_ARI_REVENUE_RATE_INVALID:${dateKey}`);
  }

  if (!Number.isFinite(majorUnits) || majorUnits <= 0) {
    throw new Error(`CHANNEX_ARI_REVENUE_RATE_INVALID:${dateKey}`);
  }

  const minorUnits = Math.round(majorUnits * 100);

  if (!Number.isSafeInteger(minorUnits) || minorUnits <= 0) {
    throw new Error(`CHANNEX_ARI_REVENUE_RATE_INVALID:${dateKey}`);
  }

  return minorUnits;
}

export async function readChannexAriSnapshot(
  db: ChannexAriSnapshotDb,
  input: ReadChannexAriSnapshotInput
): Promise<ChannexAriDeliverySnapshot> {
  const organizationId = requireText(
    input.plan.organizationId,
    "CHANNEX_ARI_ORGANIZATION_ID_REQUIRED"
  );
  const propertyId = requireText(
    input.plan.propertyId,
    "CHANNEX_ARI_PROPERTY_ID_REQUIRED"
  );

  assertPlanMappingAlignment({ plan: input.plan, mapping: input.mapping });

  const dateKeys = resolvePlanDateKeys(input.plan);
  const ratesRestrictionsChangedFields =
    input.plan.messageKind === "RATES_RESTRICTIONS"
      ? resolveRatesRestrictionsChangedFields(input.plan)
      : undefined;
  const dateFrom = dateKeys[0];
  const dateToExclusive = addUtcDays(dateKeys[dateKeys.length - 1], 1);
  const property = await db.property.findFirst({
    where: {
      id: propertyId,
      organizationId,
    },
    select: {
      id: true,
      organizationId: true,
      status: true,
      distributionEnabled: true,
      distributionStatus: true,
      timezone: true,
      minimumNights: true,
      maximumNights: true,
    },
  });

  if (!property) {
    throw new Error("CHANNEX_ARI_SNAPSHOT_PROPERTY_NOT_FOUND");
  }

  if (property.status !== "ACTIVE") {
    throw new Error("CHANNEX_ARI_SNAPSHOT_PROPERTY_NOT_ACTIVE");
  }

  if (!property.distributionEnabled || property.distributionStatus !== "ACTIVE") {
    throw new Error("CHANNEX_ARI_SNAPSHOT_DISTRIBUTION_NOT_ACTIVE");
  }

  if (input.plan.messageKind === "AVAILABILITY") {
    const propertyTimezone = requireText(
      property.timezone,
      "CHANNEX_ARI_PROPERTY_TIMEZONE_REQUIRED"
    );
    const queryFrom = toDatabaseDate(addUtcDays(dateFrom, -1));
    const queryTo = toDatabaseDate(addUtcDays(dateToExclusive, 1));
    const reservations = await db.reservation.findMany({
      where: {
        propertyId,
        status: "ACTIVE",
        checkIn: { lt: queryTo },
        checkOut: { gt: queryFrom },
      },
      select: {
        checkIn: true,
        checkOut: true,
      },
    });
    const blockedDates = await db.propertyBlockedDate.findMany({
      where: {
        propertyId,
        startDate: { lt: queryTo },
        endDate: { gt: queryFrom },
      },
      select: {
        startDate: true,
        endDate: true,
      },
    });
    const activeReservationRanges: ChannexAriAvailabilityRange[] =
      reservations.map((reservation) => ({
        startsAt: reservation.checkIn,
        endsAt: reservation.checkOut,
      }));
    const blockedRanges: ChannexAriAvailabilityRange[] = blockedDates.map(
      (blockedDate) => ({
        startsAt: blockedDate.startDate,
        endsAt: blockedDate.endDate,
      })
    );

    return {
      messageKind: "AVAILABILITY",
      data: buildChannexAriAvailabilitySnapshot({
        channexPropertyId: input.mapping.channexPropertyId,
        channexRoomTypeId: input.mapping.externalRoomTypeId,
        propertyTimezone,
        dateKeys,
        activeReservationRanges,
        blockedRanges,
      }),
    };
  }

  if (input.plan.messageKind !== "RATES_RESTRICTIONS") {
    throw new Error("CHANNEX_ARI_SNAPSHOT_MESSAGE_KIND_INVALID");
  }

  if (!Number.isSafeInteger(property.minimumNights) || property.minimumNights < 1) {
    throw new Error("CHANNEX_ARI_SNAPSHOT_MINIMUM_NIGHTS_INVALID");
  }

  const maximumNights = property.maximumNights ?? 0;

  if (!Number.isSafeInteger(maximumNights) || maximumNights < 0) {
    throw new Error("CHANNEX_ARI_SNAPSHOT_MAXIMUM_NIGHTS_INVALID");
  }

  const calculatePricing = input.calculatePricing ?? calculateDirectBookingPricing;
  const pricing = await calculatePricing({
    propertyId,
    checkIn: toDatabaseDate(dateFrom),
    checkOut: toDatabaseDate(dateToExclusive),
  });
  const nightlyRates = Array.isArray(pricing?.nightlyRates)
    ? pricing.nightlyRates
    : null;

  if (!nightlyRates) {
    throw new Error("CHANNEX_ARI_REVENUE_NIGHTLY_RATES_INVALID");
  }

  const rateByDate = new Map<string, ChannexAriRate>();

  for (const item of nightlyRates) {
    const date = assertDateKey(String(item?.date ?? ""), "revenue_date");
    const rate = normalizeRevenueRate(item?.rate, date);
    const existing = rateByDate.get(date);

    if (existing !== undefined && existing !== rate) {
      throw new Error(`CHANNEX_ARI_REVENUE_DUPLICATE_DATE_CONFLICT:${date}`);
    }

    rateByDate.set(date, rate);
  }

  const values = dateKeys.map((date) => {
    const rate = rateByDate.get(date);

    if (rate === undefined) {
      throw new Error(`CHANNEX_ARI_REVENUE_DATE_MISSING:${date}`);
    }

    return {
      date,
      rate,
      minStayArrival: property.minimumNights,
      minStayThrough: property.minimumNights,
      maxStay: maximumNights,
    };
  });

  return {
    messageKind: "RATES_RESTRICTIONS",
    data: buildChannexAriRatesRestrictionsSnapshot({
      channexPropertyId: input.mapping.channexPropertyId,
      channexRatePlanId: input.mapping.channexRatePlanId,
      changedFields: ratesRestrictionsChangedFields,
      values,
    }),
  };
}
