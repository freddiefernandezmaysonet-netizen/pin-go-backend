import { PrismaClient } from "@prisma/client";
import { HOLIDAY_PRICING_CATALOG } from "../data/holiday-pricing-catalog";

const prisma = new PrismaClient();

function normalizeMarketCountry(value: unknown) {
  const raw = String(value || "").trim();

  if (!raw) return "";

  const normalized = raw.toLowerCase();

  if (
    normalized === "us" ||
    normalized === "usa" ||
    normalized === "u.s." ||
    normalized === "u.s.a." ||
    normalized === "united states" ||
    normalized === "united states of america"
  ) {
    return "United States";
  }

  return raw;
}

function normalizeMarketRegion(value: unknown) {
  const raw = String(value || "").trim();

  if (!raw) return "";

  const normalized = raw.toLowerCase();

  if (normalized === "pr" || normalized === "puerto rico") {
    return "Puerto Rico";
  }

  return raw;
}

export async function applyDefaultHolidayPricingForProperty(propertyId: string) {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true,
      country: true,
      region: true,
    },
  });

  if (!property) {
    throw new Error("PROPERTY_NOT_FOUND");
  }

  const country = normalizeMarketCountry(property.country);

  if (!country) {
    return {
      created: 0,
      updated: 0,
      deactivated: 0,
      skipped: true,
      reason: "PROPERTY_COUNTRY_MISSING",
    };
  }

  const region = normalizeMarketRegion(property.region);

  let market = HOLIDAY_PRICING_CATALOG.find(
    (item) => item.country === country && item.region === region
  );

  if (!market) {
    market = HOLIDAY_PRICING_CATALOG.find(
      (item) => item.country === country && !item.region
    );
  }

  if (!market) {
    return {
      created: 0,
      updated: 0,
      deactivated: 0,
      skipped: true,
      reason: "NO_HOLIDAY_PRICING_TEMPLATES",
    };
  }

  let created = 0;
  let updated = 0;

  const holidayNames = new Set(market.holidays.map((holiday) => holiday.name));

  const deactivateResult = await prisma.propertyHolidayPricing.updateMany({
    where: {
      propertyId: property.id,
      source: "PIN_GO_DEFAULT",
      name: {
        notIn: Array.from(holidayNames),
      },
      isActive: true,
    },
    data: {
      isActive: false,
    },
  });

  const deactivated = deactivateResult.count;

  for (const holiday of market.holidays) {
    const existing = await prisma.propertyHolidayPricing.findFirst({
      where: {
        propertyId: property.id,
        name: holiday.name,
        source: "PIN_GO_DEFAULT",
      },
      select: {
        id: true,
        startMonth: true,
        startDay: true,
        endMonth: true,
        endDay: true,
        adjustmentPercent: true,
        isActive: true,
      },
    });

    if (!existing) {
      await prisma.propertyHolidayPricing.create({
        data: {
          propertyId: property.id,
          name: holiday.name,
          startMonth: holiday.startMonth,
          startDay: holiday.startDay,
          endMonth: holiday.endMonth,
          endDay: holiday.endDay,
          adjustmentPercent: holiday.adjustmentPercent,
          isActive: true,
          source: "PIN_GO_DEFAULT",
        },
      });

      created += 1;
      continue;
    }

    const needsUpdate =
      existing.startMonth !== holiday.startMonth ||
      existing.startDay !== holiday.startDay ||
      existing.endMonth !== holiday.endMonth ||
      existing.endDay !== holiday.endDay ||
      Number(existing.adjustmentPercent) !== Number(holiday.adjustmentPercent) ||
      existing.isActive !== true;

    if (!needsUpdate) continue;

    await prisma.propertyHolidayPricing.update({
      where: { id: existing.id },
      data: {
        startMonth: holiday.startMonth,
        startDay: holiday.startDay,
        endMonth: holiday.endMonth,
        endDay: holiday.endDay,
        adjustmentPercent: holiday.adjustmentPercent,
        isActive: true,
      },
    });

    updated += 1;
  }

  if (created > 0 || updated > 0 || deactivated > 0) {
    await prisma.property.update({
      where: { id: property.id },
      data: {
        holidayPricingEnabled: true,
      },
    });
  }

  return {
    created,
    updated,
    deactivated,
    skipped: false,
    reason: null,
  };
}