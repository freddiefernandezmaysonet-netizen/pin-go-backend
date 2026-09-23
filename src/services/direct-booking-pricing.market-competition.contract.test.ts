import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMarketCompetitionPricingStage,
  marketCompetitionPricingApplicationEnabled,
} from "./direct-booking-pricing.service";

const now = new Date("2026-09-23T12:00:00.000Z");

function database(input: {
  currency?: string;
  profileMissing?: boolean;
  targetRate?: number;
  confidence?: number;
}) {
  const calls: string[] = [];

  return {
    calls,
    prisma: {
      marketPricingProfile: {
        async findUnique() {
          calls.push("profile");
          if (input.profileMissing) return null;
          return {
            id: "profile-1",
            enabled: true,
            provider: "provider-1",
            currency: input.currency ?? "USD",
            aggressiveness: "MODERATE",
            minimumConfidence: 70,
            maximumIncreasePercent: 20,
            maximumDecreasePercent: 15,
          };
        },
      },
      marketPricingSnapshot: {
        async findMany() {
          calls.push("snapshots");
          return [
            {
              stayDate: new Date("2026-10-03T00:00:00.000Z"),
              targetRate: input.targetRate ?? 200,
              confidence: input.confidence ?? 90,
              observedAt: new Date("2026-09-23T10:00:00.000Z"),
              expiresAt: new Date("2026-09-24T12:00:00.000Z"),
              createdAt: new Date("2026-09-23T10:00:00.000Z"),
            },
          ];
        },
      },
    } as any,
  };
}

test("market pricing application remains default-off and database-free", async () => {
  const db = database({});

  assert.equal(marketCompetitionPricingApplicationEnabled({}), false);

  const [result] = await applyMarketCompetitionPricingStage(db.prisma, {
    propertyId: "property-1",
    nights: [
      {
        date: "2026-10-03",
        currentRate: 120,
        manualOverride: false,
      },
    ],
    env: {},
    now,
  });

  assert.equal(result.rate, 120);
  assert.equal(result.reason, "RUNTIME_DISABLED");
  assert.deepEqual(db.calls, []);
});

test("only an explicit true value enables market pricing application", () => {
  assert.equal(
    marketCompetitionPricingApplicationEnabled({
      PINGO_MARKET_PRICING_APPLICATION_ENABLED: "true",
    }),
    true
  );
  assert.equal(
    marketCompetitionPricingApplicationEnabled({
      PINGO_MARKET_PRICING_APPLICATION_ENABLED: "TRUE",
    }),
    true
  );

  for (const value of ["1", "yes", "enabled", "on"]) {
    assert.equal(
      marketCompetitionPricingApplicationEnabled({
        PINGO_MARKET_PRICING_APPLICATION_ENABLED: value,
      }),
      false
    );
  }
});

test("market stage adjusts the post-weekend canonical rate", async () => {
  const db = database({ targetRate: 200 });

  const [result] = await applyMarketCompetitionPricingStage(db.prisma, {
    propertyId: "property-1",
    nights: [
      {
        date: "2026-10-03",
        currentRate: 120,
        manualOverride: false,
      },
    ],
    env: {
      PINGO_MARKET_PRICING_APPLICATION_ENABLED: "true",
    },
    now,
  });

  assert.equal(result.previousRate, 120);
  assert.equal(result.rate, 140);
  assert.equal(result.reason, "APPLIED");
  assert.deepEqual(db.calls, ["profile", "profile", "snapshots"]);
});

test("manual override remains authoritative when application is enabled", async () => {
  const db = database({ targetRate: 200 });

  const [result] = await applyMarketCompetitionPricingStage(db.prisma, {
    propertyId: "property-1",
    nights: [
      {
        date: "2026-10-03",
        currentRate: 175,
        manualOverride: true,
      },
    ],
    env: {
      PINGO_MARKET_PRICING_APPLICATION_ENABLED: "true",
    },
    now,
  });

  assert.equal(result.rate, 175);
  assert.equal(result.reason, "MANUAL_OVERRIDE");
  assert.deepEqual(db.calls, ["profile", "profile"]);
});

test("profile currency is the market-stage currency source", async () => {
  const db = database({ currency: "EUR", targetRate: 200 });

  const [result] = await applyMarketCompetitionPricingStage(db.prisma, {
    propertyId: "property-eu",
    nights: [
      {
        date: "2026-10-03",
        currentRate: 120,
        manualOverride: false,
      },
    ],
    env: {
      PINGO_MARKET_PRICING_APPLICATION_ENABLED: "true",
    },
    now,
  });

  assert.equal(result.reason, "APPLIED");
  assert.equal(result.rate, 140);
});

test("missing profile fails closed without snapshot work", async () => {
  const db = database({ profileMissing: true });

  const [result] = await applyMarketCompetitionPricingStage(db.prisma, {
    propertyId: "property-1",
    nights: [
      {
        date: "2026-10-03",
        currentRate: 120,
        manualOverride: false,
      },
    ],
    env: {
      PINGO_MARKET_PRICING_APPLICATION_ENABLED: "true",
    },
    now,
  });

  assert.equal(result.rate, 120);
  assert.equal(result.reason, "PROFILE_NOT_CONFIGURED");
  assert.deepEqual(db.calls, ["profile"]);
});
