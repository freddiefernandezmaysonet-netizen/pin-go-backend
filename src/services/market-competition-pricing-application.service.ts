import type { PrismaClient } from "@prisma/client";

import {
  applyMarketCompetitionPricing,
  type MarketCompetitionPricingReason,
} from "./market-competition-pricing.policy";

type MarketPricingAggressiveness =
  | "CONSERVATIVE"
  | "MODERATE"
  | "AGGRESSIVE";

type NightlyRateInput = Readonly<{
  date: string;
  currentRate: number;
  manualOverride: boolean;
}>;

export type MarketPricingApplicationReason =
  | MarketCompetitionPricingReason
  | "RUNTIME_DISABLED"
  | "PROFILE_NOT_CONFIGURED"
  | "PROVIDER_NOT_ASSIGNED"
  | "CURRENCY_MISMATCH"
  | "SNAPSHOT_MISSING"
  | "MANUAL_OVERRIDE";

export type MarketPricingApplicationResult = Readonly<{
  date: string;
  previousRate: number;
  rate: number;
  applied: boolean;
  reason: MarketPricingApplicationReason;
  targetRate: number | null;
  confidence: number | null;
}>;

type MarketPricingApplicationPrisma = Pick<
  PrismaClient,
  "marketPricingProfile" | "marketPricingSnapshot"
>;

const ADJUSTMENT_WEIGHTS: Record<MarketPricingAggressiveness, number> = {
  CONSERVATIVE: 0.25,
  MODERATE: 0.5,
  AGGRESSIVE: 1,
};

function money(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error("MARKET_PRICING_CURRENT_RATE_INVALID");
  }
  return Math.round(number * 100) / 100;
}

function currency(value: unknown): string {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error("MARKET_PRICING_EXPECTED_CURRENCY_INVALID");
  }
  return normalized;
}

function dateKey(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error("MARKET_PRICING_STAY_DATE_INVALID");
  }
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new Error("MARKET_PRICING_STAY_DATE_INVALID");
  }
  return normalized;
}

function unchanged(
  night: NightlyRateInput,
  reason: MarketPricingApplicationReason,
): MarketPricingApplicationResult {
  const currentRate = money(night.currentRate);
  return {
    date: dateKey(night.date),
    previousRate: currentRate,
    rate: currentRate,
    applied: false,
    reason,
    targetRate: null,
    confidence: null,
  };
}

export async function applyMarketCompetitionPricingToNightlyRates(
  prisma: MarketPricingApplicationPrisma,
  input: Readonly<{
    propertyId: string;
    expectedCurrency: string;
    nights: readonly NightlyRateInput[];
    runtimeEnabled?: boolean;
    now?: Date;
  }>,
): Promise<MarketPricingApplicationResult[]> {
  const propertyId = String(input.propertyId ?? "").trim();
  if (!propertyId) throw new Error("MARKET_PRICING_PROPERTY_ID_REQUIRED");
  const expectedCurrency = currency(input.expectedCurrency);
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("MARKET_PRICING_NOW_INVALID");
  }
  if (!Array.isArray(input.nights)) {
    throw new Error("MARKET_PRICING_NIGHTS_INVALID");
  }

  const nights = input.nights.map((night) => ({
    date: dateKey(night.date),
    currentRate: money(night.currentRate),
    manualOverride: night.manualOverride === true,
  }));
  if (nights.length === 0) return [];
  if (new Set(nights.map((night) => night.date)).size !== nights.length) {
    throw new Error("MARKET_PRICING_STAY_DATE_DUPLICATE");
  }
  if (input.runtimeEnabled !== true) {
    return nights.map((night) => unchanged(night, "RUNTIME_DISABLED"));
  }

  const profile = await prisma.marketPricingProfile.findUnique({
    where: { propertyId },
    select: {
      id: true,
      enabled: true,
      provider: true,
      currency: true,
      aggressiveness: true,
      minimumConfidence: true,
      maximumIncreasePercent: true,
      maximumDecreasePercent: true,
    },
  });

  if (!profile) {
    return nights.map((night) => unchanged(night, "PROFILE_NOT_CONFIGURED"));
  }
  if (!profile.enabled) {
    return nights.map((night) => unchanged(night, "DISABLED"));
  }
  const provider = String(profile.provider ?? "").trim();
  if (!provider) {
    return nights.map((night) => unchanged(night, "PROVIDER_NOT_ASSIGNED"));
  }
  if (String(profile.currency).trim().toUpperCase() !== expectedCurrency) {
    return nights.map((night) => unchanged(night, "CURRENCY_MISMATCH"));
  }

  const automaticNights = nights.filter((night) => !night.manualOverride);
  if (automaticNights.length === 0) {
    return nights.map((night) => unchanged(night, "MANUAL_OVERRIDE"));
  }

  const snapshots = await prisma.marketPricingSnapshot.findMany({
    where: {
      profileId: profile.id,
      provider,
      stayDate: {
        in: automaticNights.map(
          (night) => new Date(`${night.date}T00:00:00.000Z`),
        ),
      },
      run: { is: { status: "SUCCEEDED" } },
    },
    select: {
      stayDate: true,
      targetRate: true,
      confidence: true,
      expiresAt: true,
      observedAt: true,
    },
    orderBy: [
      { stayDate: "asc" },
      { observedAt: "desc" },
      { createdAt: "desc" },
    ],
  });

  const latestByDate = new Map<string, (typeof snapshots)[number]>();
  for (const snapshot of snapshots) {
    const key = snapshot.stayDate.toISOString().slice(0, 10);
    if (!latestByDate.has(key)) latestByDate.set(key, snapshot);
  }

  const aggressiveness = profile.aggressiveness as MarketPricingAggressiveness;
  const adjustmentWeight = ADJUSTMENT_WEIGHTS[aggressiveness];
  if (adjustmentWeight === undefined) {
    throw new Error("MARKET_PRICING_AGGRESSIVENESS_INVALID");
  }

  return nights.map((night) => {
    if (night.manualOverride) return unchanged(night, "MANUAL_OVERRIDE");
    const snapshot = latestByDate.get(night.date);
    if (!snapshot) return unchanged(night, "SNAPSHOT_MISSING");

    const targetRate = Number(snapshot.targetRate);
    const confidence = Number(snapshot.confidence);
    const decision = applyMarketCompetitionPricing({
      enabled: true,
      currentRate: night.currentRate,
      targetRate,
      confidence,
      minimumConfidence: Number(profile.minimumConfidence),
      adjustmentWeight,
      maximumIncreasePercent: Number(profile.maximumIncreasePercent),
      maximumDecreasePercent: Number(profile.maximumDecreasePercent),
      snapshotExpiresAt: snapshot.expiresAt,
      now,
    });

    return {
      date: night.date,
      previousRate: night.currentRate,
      rate: decision.rate,
      applied: decision.applied,
      reason: decision.reason,
      targetRate,
      confidence,
    };
  });
}
