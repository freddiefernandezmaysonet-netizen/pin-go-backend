import type { PrismaClient } from "@prisma/client";

import type { MarketPricingProviderRequest } from "./market-pricing-provider.contract";
import { evaluateMarketPricingRefreshEligibility } from "./market-pricing-refresh-eligibility.policy";
import type { MarketPricingRefreshConfiguration } from "./market-pricing-refresh.service";

export type MarketPricingRefreshCandidateBlockedReason =
  | "CURRENCY_INVALID"
  | "COORDINATES_REQUIRED"
  | "COUNTRY_REQUIRED"
  | "TIMEZONE_REQUIRED"
  | "PROPERTY_DATA_INVALID";

export type MarketPricingRefreshCandidate =
  | {
      status: "READY";
      profileId: string;
      propertyId: string;
      provider: string;
      configuration: MarketPricingRefreshConfiguration;
      request: MarketPricingProviderRequest;
    }
  | {
      status: "BLOCKED";
      profileId: string;
      propertyId: string;
      provider: string;
      reason: MarketPricingRefreshCandidateBlockedReason;
    };

export type MarketPricingRefreshCandidateRepository = {
  listDue(input: {
    now: Date;
    limit: number;
    horizonDays: number;
  }): Promise<MarketPricingRefreshCandidate[]>;
};

function requireValidInput(input: {
  now: Date;
  limit: number;
  horizonDays: number;
}): void {
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new Error("MARKET_PRICING_CANDIDATE_NOW_INVALID");
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("MARKET_PRICING_CANDIDATE_LIMIT_INVALID");
  }
  if (
    !Number.isInteger(input.horizonDays) ||
    input.horizonDays < 1 ||
    input.horizonDays > 730
  ) {
    throw new Error("MARKET_PRICING_CANDIDATE_HORIZON_INVALID");
  }
}

function cleanOptional(value: string | null): string | null {
  const clean = String(value ?? "").trim();
  return clean || null;
}

function localDateKey(now: Date, timezone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const year = values.get("year");
    const month = values.get("month");
    const day = values.get("day");
    if (!year || !month || !day) return null;
    return `${year}-${month}-${day}`;
  } catch {
    return null;
  }
}

function addCalendarDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function amenityCode(name: string): string | null {
  const code = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return code || null;
}

export function createPrismaMarketPricingRefreshCandidateRepository(
  prisma: PrismaClient,
): MarketPricingRefreshCandidateRepository {
  return {
    async listDue(input) {
      requireValidInput(input);
      const profiles = await prisma.marketPricingProfile.findMany({
        where: {
          enabled: true,
          provider: { not: null },
          OR: [{ nextRefreshAt: null }, { nextRefreshAt: { lte: input.now } }],
          property: { status: "ACTIVE" },
        },
        orderBy: [
          { nextRefreshAt: { sort: "asc", nulls: "first" } },
          { createdAt: "asc" },
        ],
        take: input.limit,
        select: {
          id: true,
          provider: true,
          currency: true,
          strategy: true,
          position: true,
          aggressiveness: true,
          marketRadiusKm: true,
          maximumComparables: true,
          enabled: true,
          nextRefreshAt: true,
          property: {
            select: {
              id: true,
              latitude: true,
              longitude: true,
              country: true,
              region: true,
              city: true,
              timezone: true,
              maxGuests: true,
              amenities: {
                where: { isActive: true },
                orderBy: [{ name: "asc" }, { id: "asc" }],
                select: { name: true },
              },
            },
          },
        },
      });

      const candidates: MarketPricingRefreshCandidate[] = [];
      for (const profile of profiles) {
        const eligibility = evaluateMarketPricingRefreshEligibility({
          enabled: profile.enabled,
          provider: profile.provider,
          nextRefreshAt: profile.nextRefreshAt,
          now: input.now,
        });
        if (!eligibility.eligible) continue;

        const currency = String(profile.currency ?? "")
          .trim()
          .toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) {
          candidates.push({
            status: "BLOCKED",
            profileId: profile.id,
            propertyId: String(profile.property.id ?? "").trim(),
            provider: eligibility.provider,
            reason: "CURRENCY_INVALID",
          });
          continue;
        }

        const propertyId = String(profile.property.id ?? "").trim();
        const latitude =
          profile.property.latitude === null
            ? Number.NaN
            : Number(profile.property.latitude);
        const longitude =
          profile.property.longitude === null
            ? Number.NaN
            : Number(profile.property.longitude);
        if (
          !Number.isFinite(latitude) ||
          latitude < -90 ||
          latitude > 90 ||
          !Number.isFinite(longitude) ||
          longitude < -180 ||
          longitude > 180
        ) {
          candidates.push({
            status: "BLOCKED",
            profileId: profile.id,
            propertyId,
            provider: eligibility.provider,
            reason: "COORDINATES_REQUIRED",
          });
          continue;
        }

        const country = String(profile.property.country ?? "").trim();
        if (!country) {
          candidates.push({
            status: "BLOCKED",
            profileId: profile.id,
            propertyId,
            provider: eligibility.provider,
            reason: "COUNTRY_REQUIRED",
          });
          continue;
        }

        const timezone = String(profile.property.timezone ?? "").trim();
        const dateFrom = timezone ? localDateKey(input.now, timezone) : null;
        if (!timezone || !dateFrom) {
          candidates.push({
            status: "BLOCKED",
            profileId: profile.id,
            propertyId,
            provider: eligibility.provider,
            reason: "TIMEZONE_REQUIRED",
          });
          continue;
        }
        const marketRadiusKm =
          profile.marketRadiusKm === null
            ? null
            : Number(profile.marketRadiusKm);
        const maxGuests = profile.property.maxGuests;
        if (
          !propertyId ||
          profile.maximumComparables < 1 ||
          (marketRadiusKm !== null &&
            (!Number.isFinite(marketRadiusKm) || marketRadiusKm <= 0)) ||
          (maxGuests !== null &&
            (!Number.isInteger(maxGuests) || maxGuests < 1))
        ) {
          candidates.push({
            status: "BLOCKED",
            profileId: profile.id,
            propertyId,
            provider: eligibility.provider,
            reason: "PROPERTY_DATA_INVALID",
          });
          continue;
        }

        const amenityCodes = [
          ...new Set(
            profile.property.amenities
              .map((amenity) => amenityCode(amenity.name))
              .filter((code): code is string => code !== null),
          ),
        ].sort();

        candidates.push({
          status: "READY",
          profileId: profile.id,
          propertyId,
          provider: eligibility.provider,
          configuration: {
            profileId: profile.id,
            strategy: profile.strategy,
            position: profile.position,
            aggressiveness: profile.aggressiveness,
          },
          request: {
            property: {
              propertyId,
              latitude,
              longitude,
              country,
              region: cleanOptional(profile.property.region),
              city: cleanOptional(profile.property.city),
              timezone,
              currency,
              propertyType: null,
              bedrooms: null,
              bathrooms: null,
              maxGuests,
              amenityCodes,
            },
            dateFrom,
            dateToExclusive: addCalendarDays(dateFrom, input.horizonDays),
            marketRadiusKm,
            maximumComparables: profile.maximumComparables,
          },
        });
      }

      return candidates;
    },
  };
}
