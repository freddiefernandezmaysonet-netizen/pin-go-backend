import { Prisma, type PrismaClient } from "@prisma/client";
import assert from "node:assert/strict";
import test from "node:test";

import {
  createPrismaMarketPricingRefreshCandidateRepository,
  type MarketPricingRefreshCandidate,
} from "./market-pricing-refresh-candidate.prisma-repository";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value as UnknownRecord;
}

function requiredCandidate(
  value: MarketPricingRefreshCandidate | undefined,
): MarketPricingRefreshCandidate {
  if (!value) throw new Error("Expected a refresh candidate");
  return value;
}

function readyCandidate(
  value: MarketPricingRefreshCandidate | undefined,
): Extract<MarketPricingRefreshCandidate, { status: "READY" }> {
  const candidate = requiredCandidate(value);
  assert.equal(candidate.status, "READY");
  if (candidate.status !== "READY") throw new Error("Expected READY");
  return candidate;
}

async function errorMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("EXPECTED_OPERATION_TO_REJECT");
}

function profile(overrides: UnknownRecord = {}): UnknownRecord {
  return {
    id: "profile-1",
    provider: "  provider-a  ",
    currency: " usd ",
    strategy: "BALANCED",
    position: "COMPETITIVE",
    aggressiveness: "MODERATE",
    marketRadiusKm: new Prisma.Decimal(10),
    maximumComparables: 10,
    enabled: true,
    nextRefreshAt: null,
    property: {
      id: "property-1",
      latitude: new Prisma.Decimal("18.2100000"),
      longitude: new Prisma.Decimal("-66.5100000"),
      country: "PR",
      region: "Puerto Rico",
      city: "San Juan",
      timezone: "America/Puerto_Rico",
      maxGuests: 4,
      amenities: [
        { name: "Wi-Fi" },
        { name: "Aire acondicionado" },
        { name: "Wi-Fi" },
      ],
    },
    ...overrides,
  };
}

function repositoryFixture(profiles: UnknownRecord[]) {
  const queries: unknown[] = [];
  const prisma = {
    marketPricingProfile: {
      async findMany(args: unknown): Promise<UnknownRecord[]> {
        queries.push(args);
        return profiles;
      },
    },
  } as unknown as PrismaClient;

  return {
    repository: createPrismaMarketPricingRefreshCandidateRepository(prisma),
    queries,
  };
}

test("a due Puerto Rico profile becomes a provider-ready local-date request", async () => {
  const fixture = repositoryFixture([profile()]);

  const candidates = await fixture.repository.listDue({
    now: new Date("2026-09-23T02:30:00.000Z"),
    limit: 20,
    horizonDays: 365,
  });

  assert.equal(candidates.length, 1);
  const candidate = readyCandidate(candidates[0]);
  assert.equal(candidate.provider, "provider-a");
  assert.deepEqual(candidate.configuration, {
    profileId: "profile-1",
    strategy: "BALANCED",
    position: "COMPETITIVE",
    aggressiveness: "MODERATE",
  });
  assert.deepEqual(candidate.request, {
    property: {
      propertyId: "property-1",
      latitude: 18.21,
      longitude: -66.51,
      country: "PR",
      region: "Puerto Rico",
      city: "San Juan",
      timezone: "America/Puerto_Rico",
      currency: "USD",
      propertyType: null,
      bedrooms: null,
      bathrooms: null,
      maxGuests: 4,
      amenityCodes: ["AIRE_ACONDICIONADO", "WI_FI"],
    },
    dateFrom: "2026-09-22",
    dateToExclusive: "2027-09-22",
    marketRadiusKm: 10,
    maximumComparables: 10,
  });
});

test("the same instant uses the property's timezone for another world market", async () => {
  const tokyo = profile({
    currency: " jpy ",
    property: {
      ...record(profile().property),
      country: "JP",
      region: null,
      city: "Tokyo",
      timezone: "Asia/Tokyo",
    },
  });
  const fixture = repositoryFixture([tokyo]);

  const candidates = await fixture.repository.listDue({
    now: new Date("2026-09-22T20:00:00.000Z"),
    limit: 10,
    horizonDays: 30,
  });

  const candidate = readyCandidate(candidates[0]);
  assert.equal(candidate.request.dateFrom, "2026-09-23");
  assert.equal(candidate.request.dateToExclusive, "2026-10-23");
  assert.equal(candidate.request.property.currency, "JPY");
});

test("missing coordinates block the candidate instead of becoming zeroes", async () => {
  const missingCoordinates = profile({
    property: {
      ...record(profile().property),
      latitude: null,
      longitude: null,
    },
  });
  const fixture = repositoryFixture([missingCoordinates]);

  const candidates = await fixture.repository.listDue({
    now: new Date("2026-09-22T20:00:00.000Z"),
    limit: 10,
    horizonDays: 365,
  });

  assert.deepEqual(candidates[0], {
    status: "BLOCKED",
    profileId: "profile-1",
    propertyId: "property-1",
    provider: "provider-a",
    reason: "COORDINATES_REQUIRED",
  });
});

test("country and timezone deficiencies receive explicit blocked reasons", async () => {
  const cases = [
    {
      property: { ...record(profile().property), country: "   " },
      reason: "COUNTRY_REQUIRED",
    },
    {
      property: {
        ...record(profile().property),
        timezone: "Not/A_Timezone",
      },
      reason: "TIMEZONE_REQUIRED",
    },
  ];

  for (const item of cases) {
    const fixture = repositoryFixture([profile({ property: item.property })]);
    const candidates = await fixture.repository.listDue({
      now: new Date("2026-09-22T20:00:00.000Z"),
      limit: 10,
      horizonDays: 365,
    });
    const candidate = requiredCandidate(candidates[0]);
    assert.equal(candidate.status, "BLOCKED");
    assert.equal(record(candidate).reason, item.reason);
  }
});

test("invalid property capacity or radius fails closed", async () => {
  const fixture = repositoryFixture([
    profile({ marketRadiusKm: new Prisma.Decimal(0) }),
    profile({
      id: "profile-2",
      property: {
        ...record(profile().property),
        id: "property-2",
        maxGuests: 0,
      },
    }),
  ]);

  const candidates = await fixture.repository.listDue({
    now: new Date("2026-09-22T20:00:00.000Z"),
    limit: 10,
    horizonDays: 365,
  });

  assert.deepEqual(
    candidates.map((candidate) => record(candidate).reason),
    ["PROPERTY_DATA_INVALID", "PROPERTY_DATA_INVALID"],
  );
});

test("the database query selects bounded due profiles in deterministic order", async () => {
  const fixture = repositoryFixture([]);
  const now = new Date("2026-09-22T20:00:00.000Z");

  await fixture.repository.listDue({
    now,
    limit: 2,
    horizonDays: 90,
  });

  const query = record(fixture.queries[0]);
  assert.equal(query.take, 2);
  const where = record(query.where);
  assert.equal(where.enabled, true);
  assert.deepEqual(where.provider, { not: null });
  assert.deepEqual(where.property, { status: "ACTIVE" });
  assert.deepEqual(where.OR, [
    { nextRefreshAt: null },
    { nextRefreshAt: { lte: now } },
  ]);
  assert.deepEqual(query.orderBy, [
    { nextRefreshAt: { sort: "asc", nulls: "first" } },
    { createdAt: "asc" },
  ]);
  assert.equal(record(query.select).currency, true);
});

test("a defensive eligibility check skips an unexpected future profile", async () => {
  const fixture = repositoryFixture([
    profile({ nextRefreshAt: new Date("2026-09-23T20:00:00.000Z") }),
  ]);

  const candidates = await fixture.repository.listDue({
    now: new Date("2026-09-22T20:00:00.000Z"),
    limit: 10,
    horizonDays: 365,
  });

  assert.deepEqual(candidates, []);
});

test("an invalid profile currency is blocked without affecting other markets", async () => {
  const fixture = repositoryFixture([
    profile({ currency: "US" }),
    profile({
      id: "profile-2",
      currency: "EUR",
      property: { ...record(profile().property), id: "property-2" },
    }),
  ]);

  const candidates = await fixture.repository.listDue({
    now: new Date("2026-09-22T20:00:00.000Z"),
    limit: 10,
    horizonDays: 365,
  });

  assert.equal(record(candidates[0]).reason, "CURRENCY_INVALID");
  assert.equal(readyCandidate(candidates[1]).request.property.currency, "EUR");
});

test("invalid batch, horizon, or clock inputs are rejected", async () => {
  const fixture = repositoryFixture([]);
  const valid = {
    now: new Date("2026-09-22T20:00:00.000Z"),
    limit: 10,
    horizonDays: 365,
  };

  assert.equal(
    await errorMessage(
      fixture.repository.listDue({ ...valid, now: new Date("invalid") }),
    ),
    "MARKET_PRICING_CANDIDATE_NOW_INVALID",
  );
  assert.equal(
    await errorMessage(fixture.repository.listDue({ ...valid, limit: 0 })),
    "MARKET_PRICING_CANDIDATE_LIMIT_INVALID",
  );
  assert.equal(
    await errorMessage(
      fixture.repository.listDue({ ...valid, horizonDays: 731 }),
    ),
    "MARKET_PRICING_CANDIDATE_HORIZON_INVALID",
  );
  assert.equal(fixture.queries.length, 0);
});
