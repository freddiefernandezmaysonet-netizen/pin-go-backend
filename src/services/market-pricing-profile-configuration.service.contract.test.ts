import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import {
  configureMarketPricingProfile,
  getMarketPricingProfileConfiguration,
} from "./market-pricing-profile-configuration.service";

function prismaDouble(input: {
  property?: { id: string; marketPricingProfile: { provider: string | null } | null } | null;
} = {}) {
  const calls: { propertyQuery: unknown[]; upsert: unknown[] } = {
    propertyQuery: [],
    upsert: [],
  };
  const prisma = {
    property: {
      async findFirst(query: unknown) {
        calls.propertyQuery.push(query);
        return input.property === undefined
          ? { id: "property-1", marketPricingProfile: null }
          : input.property;
      },
    },
    marketPricingProfile: {
      async upsert(query: any) {
        calls.upsert.push(query);
        return {
          id: "profile-1",
          ...query.create,
          refreshIntervalHours: 24,
          updatedAt: new Date("2026-09-23T00:00:00.000Z"),
        };
      },
    },
  } as unknown as PrismaClient;

  return { prisma, calls };
}

function baseInput() {
  return {
    organizationId: "organization-1",
    propertyId: "property-1",
    configuration: {
      enabled: false,
      currency: "usd",
    },
  };
}

test("creates a safe disabled profile with normalized currency and defaults", async () => {
  const { prisma, calls } = prismaDouble();

  const result = await configureMarketPricingProfile(prisma, baseInput());

  assert.equal(result.enabled, false);
  assert.equal(result.currency, "USD");
  assert.equal(result.provider, null);
  assert.equal(calls.upsert.length, 1);
  const create = (calls.upsert[0] as any).create;
  assert.deepEqual(
    {
      strategy: create.strategy,
      position: create.position,
      aggressiveness: create.aggressiveness,
      minimumConfidence: create.minimumConfidence,
      maximumIncreasePercent: create.maximumIncreasePercent,
      maximumDecreasePercent: create.maximumDecreasePercent,
      marketRadiusKm: create.marketRadiusKm,
      maximumComparables: create.maximumComparables,
      nextRefreshAt: create.nextRefreshAt,
    },
    {
      strategy: "BALANCED",
      position: "COMPETITIVE",
      aggressiveness: "MODERATE",
      minimumConfidence: 70,
      maximumIncreasePercent: 20,
      maximumDecreasePercent: 15,
      marketRadiusKm: null,
      maximumComparables: 10,
      nextRefreshAt: null,
    },
  );
});

test("activation requires and stores a trusted provider key", async () => {
  const { prisma, calls } = prismaDouble();

  await configureMarketPricingProfile(prisma, {
    ...baseInput(),
    assignedProviderKey: "market-provider-v1",
    configuration: {
      enabled: true,
      currency: "eur",
      strategy: "revenue",
      position: "premium",
      aggressiveness: "aggressive",
      marketRadiusKm: 25,
      maximumComparables: 20,
    },
  });

  const create = (calls.upsert[0] as any).create;
  assert.equal(create.provider, "market-provider-v1");
  assert.equal(create.enabled, true);
  assert.equal(create.currency, "EUR");
  assert.equal(create.strategy, "REVENUE");
  assert.equal(create.position, "PREMIUM");
  assert.equal(create.aggressiveness, "AGGRESSIVE");
  assert.equal(create.marketRadiusKm, 25);
  assert.equal(create.maximumComparables, 20);
  assert.equal(create.nextRefreshAt, null);
});

test("reconfiguration preserves the system provider when it is omitted", async () => {
  const { prisma, calls } = prismaDouble({
    property: {
      id: "property-1",
      marketPricingProfile: { provider: "existing-provider" },
    },
  });

  await configureMarketPricingProfile(prisma, {
    ...baseInput(),
    configuration: { enabled: true, currency: "jpy" },
  });

  assert.equal((calls.upsert[0] as any).update.provider, "existing-provider");
  assert.equal((calls.upsert[0] as any).update.currency, "JPY");
});

test("activation without an assigned provider fails before persistence", async () => {
  const { prisma, calls } = prismaDouble();

  await assert.rejects(
    configureMarketPricingProfile(prisma, {
      ...baseInput(),
      configuration: { enabled: true, currency: "USD" },
    }),
    /MARKET_PRICING_PROVIDER_REQUIRED_FOR_ACTIVATION/,
  );
  assert.equal(calls.upsert.length, 0);
});

test("property lookup is tenant-scoped and excludes archived properties", async () => {
  const { prisma, calls } = prismaDouble({ property: null });

  await assert.rejects(
    configureMarketPricingProfile(prisma, baseInput()),
    /MARKET_PRICING_PROPERTY_NOT_FOUND/,
  );
  assert.deepEqual((calls.propertyQuery[0] as any).where, {
    id: "property-1",
    organizationId: "organization-1",
    status: { not: "ARCHIVED" },
  });
  assert.equal(calls.upsert.length, 0);
});

test("invalid host configuration is rejected before any database read", async () => {
  const invalidConfigurations = [
    { enabled: "true", currency: "USD" },
    { enabled: false, currency: "US" },
    { enabled: false, currency: "USD", strategy: "FAST" },
    { enabled: false, currency: "USD", position: "FIRST" },
    { enabled: false, currency: "USD", aggressiveness: "MAX" },
    { enabled: false, currency: "USD", minimumConfidence: 101 },
    { enabled: false, currency: "USD", maximumIncreasePercent: -1 },
    { enabled: false, currency: "USD", maximumDecreasePercent: 101 },
    { enabled: false, currency: "USD", marketRadiusKm: 0 },
    { enabled: false, currency: "USD", maximumComparables: 1.5 },
  ];

  for (const candidate of invalidConfigurations) {
    const { prisma, calls } = prismaDouble();
    await assert.rejects(
      configureMarketPricingProfile(prisma, {
        ...baseInput(),
        configuration: candidate,
      }),
    );
    assert.equal(calls.propertyQuery.length, 0);
    assert.equal(calls.upsert.length, 0);
  }
});

test("unsafe provider keys are rejected before any database read", async () => {
  for (const assignedProviderKey of ["", " provider ", "provider/key"]) {
    const { prisma, calls } = prismaDouble();
    await assert.rejects(
      configureMarketPricingProfile(prisma, {
        ...baseInput(),
        assignedProviderKey,
      }),
      /MARKET_PRICING_PROVIDER_KEY_INVALID/,
    );
    assert.equal(calls.propertyQuery.length, 0);
  }
});

test("a provider can only be removed while the profile is disabled", async () => {
  const { prisma, calls } = prismaDouble({
    property: {
      id: "property-1",
      marketPricingProfile: { provider: "existing-provider" },
    },
  });

  await configureMarketPricingProfile(prisma, {
    ...baseInput(),
    assignedProviderKey: null,
  });
  assert.equal((calls.upsert[0] as any).update.provider, null);

  await assert.rejects(
    configureMarketPricingProfile(prisma, {
      ...baseInput(),
      assignedProviderKey: null,
      configuration: { enabled: true, currency: "USD" },
    }),
    /MARKET_PRICING_PROVIDER_REQUIRED_FOR_ACTIVATION/,
  );
});

test("read model reports an unconfigured property without inventing defaults", async () => {
  const { prisma, calls } = prismaDouble();

  const result = await getMarketPricingProfileConfiguration(prisma, {
    organizationId: "organization-1",
    propertyId: "property-1",
  });

  assert.deepEqual(result, { configured: false, profile: null });
  assert.equal(calls.propertyQuery.length, 1);
});

test("read model returns the stored profile through a tenant-scoped lookup", async () => {
  const profile = {
    id: "profile-1",
    propertyId: "property-1",
    enabled: true,
    provider: "existing-provider",
    currency: "USD",
  };
  const { prisma, calls } = prismaDouble({
    property: { id: "property-1", marketPricingProfile: profile },
  });

  const result = await getMarketPricingProfileConfiguration(prisma, {
    organizationId: "organization-1",
    propertyId: "property-1",
  });

  assert.deepEqual(result, { configured: true, profile });
  assert.deepEqual((calls.propertyQuery[0] as any).where, {
    id: "property-1",
    organizationId: "organization-1",
    status: { not: "ARCHIVED" },
  });
});

test("read model does not reveal a missing or cross-tenant property", async () => {
  const { prisma } = prismaDouble({ property: null });

  await assert.rejects(
    getMarketPricingProfileConfiguration(prisma, {
      organizationId: "another-organization",
      propertyId: "property-1",
    }),
    /MARKET_PRICING_PROPERTY_NOT_FOUND/,
  );
});
