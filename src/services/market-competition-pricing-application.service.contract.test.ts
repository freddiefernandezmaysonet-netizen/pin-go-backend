import assert from "node:assert/strict";
import test from "node:test";

import { applyMarketCompetitionPricingToNightlyRates } from "./market-competition-pricing-application.service";

const now = new Date("2026-09-23T12:00:00.000Z");

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: "profile-1",
    enabled: true,
    provider: "provider-1",
    currency: "USD",
    aggressiveness: "MODERATE",
    minimumConfidence: 70,
    maximumIncreasePercent: 20,
    maximumDecreasePercent: 15,
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    stayDate: new Date("2026-10-01T00:00:00.000Z"),
    targetRate: 220,
    confidence: 90,
    observedAt: new Date("2026-09-23T10:00:00.000Z"),
    expiresAt: new Date("2026-09-24T12:00:00.000Z"),
    ...overrides,
  };
}

function db(input: { profile?: any; snapshots?: any[] }) {
  const calls: string[] = [];
  return {
    calls,
    prisma: {
      marketPricingProfile: {
        async findUnique() {
          calls.push("profile");
          return input.profile === undefined ? profile() : input.profile;
        },
      },
      marketPricingSnapshot: {
        async findMany() {
          calls.push("snapshots");
          return input.snapshots ?? [snapshot()];
        },
      },
    } as any,
  };
}

const night = {
  date: "2026-10-01",
  currentRate: 180,
  manualOverride: false,
};

test("applies the latest successful snapshot gradually", async () => {
  const database = db({
    snapshots: [
      snapshot(),
      snapshot({
        targetRate: 300,
        observedAt: new Date("2026-09-22T10:00:00.000Z"),
      }),
    ],
  });
  const result = await applyMarketCompetitionPricingToNightlyRates(
    database.prisma,
    { propertyId: "property-1", expectedCurrency: "USD", nights: [night], runtimeEnabled: true, now },
  );

  assert.deepEqual(result, [{
    date: "2026-10-01",
    previousRate: 180,
    rate: 200,
    applied: true,
    reason: "APPLIED",
    targetRate: 220,
    confidence: 90,
  }]);
  assert.deepEqual(database.calls, ["profile", "snapshots"]);
});

test("manual override remains authoritative", async () => {
  const database = db({});
  const result = await applyMarketCompetitionPricingToNightlyRates(
    database.prisma,
    {
      propertyId: "property-1",
      expectedCurrency: "USD",
      nights: [{ ...night, manualOverride: true }],
      runtimeEnabled: true,
      now,
    },
  );
  assert.equal(result[0].rate, 180);
  assert.equal(result[0].reason, "MANUAL_OVERRIDE");
  assert.equal(result[0].applied, false);
  assert.deepEqual(database.calls, ["profile"]);
});

test("low confidence safely keeps the canonical rate", async () => {
  const database = db({ snapshots: [snapshot({ confidence: 69 })] });
  const [result] = await applyMarketCompetitionPricingToNightlyRates(
    database.prisma,
    { propertyId: "property-1", expectedCurrency: "USD", nights: [night], runtimeEnabled: true, now },
  );
  assert.equal(result.rate, 180);
  assert.equal(result.reason, "LOW_CONFIDENCE");
});

test("an expired snapshot safely keeps the canonical rate", async () => {
  const database = db({
    snapshots: [snapshot({ expiresAt: new Date("2026-09-23T11:59:59.999Z") })],
  });
  const [result] = await applyMarketCompetitionPricingToNightlyRates(
    database.prisma,
    { propertyId: "property-1", expectedCurrency: "USD", nights: [night], runtimeEnabled: true, now },
  );
  assert.equal(result.rate, 180);
  assert.equal(result.reason, "EXPIRED_SNAPSHOT");
});

test("currency mismatch fails closed before reading snapshots", async () => {
  const database = db({ profile: profile({ currency: "EUR" }) });
  const [result] = await applyMarketCompetitionPricingToNightlyRates(
    database.prisma,
    { propertyId: "property-1", expectedCurrency: "USD", nights: [night], runtimeEnabled: true, now },
  );
  assert.equal(result.rate, 180);
  assert.equal(result.reason, "CURRENCY_MISMATCH");
  assert.deepEqual(database.calls, ["profile"]);
});

test("a disabled profile performs no snapshot work", async () => {
  const database = db({ profile: profile({ enabled: false }) });
  const [result] = await applyMarketCompetitionPricingToNightlyRates(
    database.prisma,
    { propertyId: "property-1", expectedCurrency: "USD", nights: [night], runtimeEnabled: true, now },
  );
  assert.equal(result.reason, "DISABLED");
  assert.deepEqual(database.calls, ["profile"]);
});

test("missing market evidence leaves the certified rate unchanged", async () => {
  const database = db({ snapshots: [] });
  const [result] = await applyMarketCompetitionPricingToNightlyRates(
    database.prisma,
    { propertyId: "property-1", expectedCurrency: "USD", nights: [night], runtimeEnabled: true, now },
  );
  assert.equal(result.rate, 180);
  assert.equal(result.reason, "SNAPSHOT_MISSING");
});

test("runtime is database-free and disabled by default", async () => {
  const database = db({});
  const [result] = await applyMarketCompetitionPricingToNightlyRates(
    database.prisma,
    { propertyId: "property-1", expectedCurrency: "USD", nights: [night], now },
  );
  assert.equal(result.rate, 180);
  assert.equal(result.reason, "RUNTIME_DISABLED");
  assert.deepEqual(database.calls, []);
});
