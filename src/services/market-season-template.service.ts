import { PrismaClient } from "@prisma/client";

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

export async function applyDefaultMarketSeasonsForProperty(propertyId: string) {
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
    console.log("[Market Seasons] skipped", {
      propertyId,
      reason: "PROPERTY_COUNTRY_MISSING",
    });

    return {
      created: 0,
      updated: 0,
      deactivated: 0,
      skipped: true,
      reason: "PROPERTY_COUNTRY_MISSING",
    };
  }

  const region = normalizeMarketRegion(property.region);

  
  let templates = await prisma.marketSeasonTemplate.findMany({
    where: {
      country,
      region: region || null,
      isActive: true,
    },
    orderBy: [{ startMonth: "asc" }, { startDay: "asc" }],
  });

  
  if (templates.length === 0) {
    templates = await prisma.marketSeasonTemplate.findMany({
      where: {
        country,
        region: null,
        isActive: true,
      },
      orderBy: [{ startMonth: "asc" }, { startDay: "asc" }],
    });

     }

  if (templates.length === 0) {
    console.log("[Market Seasons] skipped", {
      propertyId,
      country,
      region,
      reason: "NO_MARKET_SEASON_TEMPLATES",
    });

    return {
      created: 0,
      updated: 0,
      deactivated: 0,
      skipped: true,
      reason: "NO_MARKET_SEASON_TEMPLATES",
    };
  }

  let created = 0;
  let updated = 0;

  const templateNames = new Set(templates.map((template) => template.name));

  const deactivateResult = await prisma.propertySeason.updateMany({
    where: {
      propertyId: property.id,
      source: "PIN_GO_DEFAULT",
      name: {
        notIn: Array.from(templateNames),
      },
      isActive: true,
    },
    data: {
      isActive: false,
    },
  });

  const deactivated = deactivateResult.count;

  for (const template of templates) {
    const existing = await prisma.propertySeason.findFirst({
      where: {
        propertyId: property.id,
        name: template.name,
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
        type: true,
      },
    });

    if (!existing) {
      await prisma.propertySeason.create({
        data: {
          propertyId: property.id,
          name: template.name,
          startMonth: template.startMonth,
          startDay: template.startDay,
          endMonth: template.endMonth,
          endDay: template.endDay,
          adjustmentPercent: template.adjustmentPercent,
          isActive: true,
          type: template.type,
          source: "PIN_GO_DEFAULT",
        },
      });

      created += 1;
      continue;
    }

    const needsUpdate =
      existing.startMonth !== template.startMonth ||
      existing.startDay !== template.startDay ||
      existing.endMonth !== template.endMonth ||
      existing.endDay !== template.endDay ||
      Number(existing.adjustmentPercent) !== Number(template.adjustmentPercent) ||
      existing.type !== template.type ||
      existing.isActive !== true;

    if (!needsUpdate) continue;

    await prisma.propertySeason.update({
      where: { id: existing.id },
      data: {
        startMonth: template.startMonth,
        startDay: template.startDay,
        endMonth: template.endMonth,
        endDay: template.endDay,
        adjustmentPercent: template.adjustmentPercent,
        type: template.type,
        isActive: true,
      },
    });

    updated += 1;
  }

  if (created > 0 || updated > 0 || deactivated > 0) {
    await prisma.property.update({
      where: { id: property.id },
      data: {
        seasonalPricingEnabled: true,
      },
    });
  }

  console.log("[Market Seasons] apply result", {
    propertyId,
    created,
    updated,
    deactivated,
    seasonalPricingEnabledUpdated: created > 0 || updated > 0 || deactivated > 0,
  });

  return {
    created,
    updated,
    deactivated,
    skipped: false,
    reason: null,
  };
}