import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function applyDefaultMarketSeasonsForProperty(propertyId: string) {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true,
      country: true,
    },
  });

  if (!property) {
    throw new Error("PROPERTY_NOT_FOUND");
  }

  const country = String(property.country || "").trim();

  if (!country) {
    return {
      created: 0,
      skipped: true,
      reason: "PROPERTY_COUNTRY_MISSING",
    };
  }

  const templates = await prisma.marketSeasonTemplate.findMany({
    where: {
      country,
      isActive: true,
    },
    orderBy: [
      { startMonth: "asc" },
      { startDay: "asc" },
    ],
  });

  if (templates.length === 0) {
    return {
      created: 0,
      skipped: true,
      reason: "NO_MARKET_SEASON_TEMPLATES",
    };
  }

  let created = 0;

  for (const template of templates) {
    const existing = await prisma.propertySeason.findFirst({
      where: {
        propertyId: property.id,
        name: template.name,
        source: "PIN_GO_DEFAULT",
      },
      select: { id: true },
    });

    if (existing) continue;

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
        source: "PIN_GO_DEFAULT",
      },
    });

    created += 1;
  }

  if (created > 0) {
    await prisma.property.update({
      where: { id: property.id },
      data: {
        seasonalPricingEnabled: true,
      },
    });
  }

  return {
    created,
    skipped: false,
    reason: null,
  };
}