import type { PrismaClient } from "@prisma/client";

const PROVIDER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STRATEGIES = new Set(["OCCUPANCY", "BALANCED", "REVENUE"]);
const POSITIONS = new Set(["VALUE", "COMPETITIVE", "PREMIUM"]);
const AGGRESSIVENESS = new Set(["CONSERVATIVE", "MODERATE", "AGGRESSIVE"]);

export type MarketPricingProfileConfiguration = {
  enabled: boolean;
  currency: string;
  strategy: "OCCUPANCY" | "BALANCED" | "REVENUE";
  position: "VALUE" | "COMPETITIVE" | "PREMIUM";
  aggressiveness: "CONSERVATIVE" | "MODERATE" | "AGGRESSIVE";
  minimumConfidence: number;
  maximumIncreasePercent: number;
  maximumDecreasePercent: number;
  marketRadiusKm: number | null;
  maximumComparables: number;
};

export type ConfigureMarketPricingProfileInput = {
  organizationId: string;
  propertyId: string;
  assignedProviderKey?: string | null;
  configuration: {
    enabled: unknown;
    currency: unknown;
    strategy?: unknown;
    position?: unknown;
    aggressiveness?: unknown;
    minimumConfidence?: unknown;
    maximumIncreasePercent?: unknown;
    maximumDecreasePercent?: unknown;
    marketRadiusKm?: unknown;
    maximumComparables?: unknown;
  };
};

const PROFILE_SELECT = {
  id: true,
  propertyId: true,
  enabled: true,
  provider: true,
  currency: true,
  strategy: true,
  position: true,
  aggressiveness: true,
  minimumConfidence: true,
  maximumIncreasePercent: true,
  maximumDecreasePercent: true,
  marketRadiusKm: true,
  maximumComparables: true,
  refreshIntervalHours: true,
  nextRefreshAt: true,
  lastSuccessfulRefreshAt: true,
  lastErrorCode: true,
  updatedAt: true,
} as const;

function requiredId(value: string, code: string): string {
  const clean = String(value ?? "").trim();
  if (!clean) throw new Error(code);
  return clean;
}

function enumValue<T extends string>(
  value: unknown,
  fallback: T,
  allowed: ReadonlySet<string>,
  code: string,
): T {
  const normalized = String(value ?? fallback).trim().toUpperCase();
  if (!allowed.has(normalized)) throw new Error(code);
  return normalized as T;
}

function boundedNumber(input: {
  value: unknown;
  fallback: number;
  minimum: number;
  maximum: number;
  integer?: boolean;
  code: string;
}): number {
  const value = input.value === undefined ? input.fallback : Number(input.value);
  if (
    !Number.isFinite(value) ||
    value < input.minimum ||
    value > input.maximum ||
    (input.integer === true && !Number.isInteger(value))
  ) {
    throw new Error(input.code);
  }
  return value;
}

function optionalRadius(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  return boundedNumber({
    value,
    fallback: 10,
    minimum: 0.1,
    maximum: 100,
    code: "MARKET_PRICING_RADIUS_INVALID",
  });
}

function providerKey(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value !== value.trim() || !PROVIDER_KEY_PATTERN.test(value)) {
    throw new Error("MARKET_PRICING_PROVIDER_KEY_INVALID");
  }
  return value;
}

function configuration(
  input: ConfigureMarketPricingProfileInput["configuration"],
): MarketPricingProfileConfiguration {
  if (typeof input?.enabled !== "boolean") {
    throw new Error("MARKET_PRICING_ENABLED_INVALID");
  }
  const currency = String(input.currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("MARKET_PRICING_CURRENCY_INVALID");
  }

  return {
    enabled: input.enabled,
    currency,
    strategy: enumValue(
      input.strategy,
      "BALANCED",
      STRATEGIES,
      "MARKET_PRICING_STRATEGY_INVALID",
    ),
    position: enumValue(
      input.position,
      "COMPETITIVE",
      POSITIONS,
      "MARKET_PRICING_POSITION_INVALID",
    ),
    aggressiveness: enumValue(
      input.aggressiveness,
      "MODERATE",
      AGGRESSIVENESS,
      "MARKET_PRICING_AGGRESSIVENESS_INVALID",
    ),
    minimumConfidence: boundedNumber({
      value: input.minimumConfidence,
      fallback: 70,
      minimum: 0,
      maximum: 100,
      code: "MARKET_PRICING_MINIMUM_CONFIDENCE_INVALID",
    }),
    maximumIncreasePercent: boundedNumber({
      value: input.maximumIncreasePercent,
      fallback: 20,
      minimum: 0,
      maximum: 100,
      code: "MARKET_PRICING_MAXIMUM_INCREASE_INVALID",
    }),
    maximumDecreasePercent: boundedNumber({
      value: input.maximumDecreasePercent,
      fallback: 15,
      minimum: 0,
      maximum: 100,
      code: "MARKET_PRICING_MAXIMUM_DECREASE_INVALID",
    }),
    marketRadiusKm: optionalRadius(input.marketRadiusKm),
    maximumComparables: boundedNumber({
      value: input.maximumComparables,
      fallback: 10,
      minimum: 1,
      maximum: 50,
      integer: true,
      code: "MARKET_PRICING_MAXIMUM_COMPARABLES_INVALID",
    }),
  };
}

export async function getMarketPricingProfileConfiguration(
  prisma: PrismaClient,
  input: { organizationId: string; propertyId: string },
) {
  const organizationId = requiredId(
    input.organizationId,
    "MARKET_PRICING_ORGANIZATION_ID_REQUIRED",
  );
  const propertyId = requiredId(
    input.propertyId,
    "MARKET_PRICING_PROPERTY_ID_REQUIRED",
  );
  const property = await prisma.property.findFirst({
    where: {
      id: propertyId,
      organizationId,
      status: { not: "ARCHIVED" },
    },
    select: {
      id: true,
      marketPricingProfile: { select: PROFILE_SELECT },
    },
  });
  if (!property) throw new Error("MARKET_PRICING_PROPERTY_NOT_FOUND");

  return property.marketPricingProfile
    ? { configured: true as const, profile: property.marketPricingProfile }
    : { configured: false as const, profile: null };
}

export async function configureMarketPricingProfile(
  prisma: PrismaClient,
  input: ConfigureMarketPricingProfileInput,
) {
  const organizationId = requiredId(
    input.organizationId,
    "MARKET_PRICING_ORGANIZATION_ID_REQUIRED",
  );
  const propertyId = requiredId(
    input.propertyId,
    "MARKET_PRICING_PROPERTY_ID_REQUIRED",
  );
  const requested = configuration(input.configuration);
  const requestedProvider = providerKey(input.assignedProviderKey);

  const property = await prisma.property.findFirst({
    where: {
      id: propertyId,
      organizationId,
      status: { not: "ARCHIVED" },
    },
    select: {
      id: true,
      marketPricingProfile: {
        select: { provider: true },
      },
    },
  });
  if (!property) throw new Error("MARKET_PRICING_PROPERTY_NOT_FOUND");

  const provider =
    requestedProvider === undefined
      ? property.marketPricingProfile?.provider ?? null
      : requestedProvider;
  if (requested.enabled && !provider) {
    throw new Error("MARKET_PRICING_PROVIDER_REQUIRED_FOR_ACTIVATION");
  }

  return prisma.marketPricingProfile.upsert({
    where: { propertyId },
    create: {
      propertyId,
      provider,
      ...requested,
      nextRefreshAt: null,
      lastErrorCode: null,
    },
    update: {
      provider,
      ...requested,
      nextRefreshAt: null,
      lastErrorCode: null,
    },
    select: PROFILE_SELECT,
  });
}
