import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMarketCompetitionPricing,
  type MarketCompetitionPricingInput,
} from "./market-competition-pricing.policy";

const now = new Date("2026-09-22T12:00:00.000Z");
const validUntil = new Date("2026-09-23T12:00:00.000Z");

function baseline(
  overrides: Partial<MarketCompetitionPricingInput> = {}
): MarketCompetitionPricingInput {
  return {
    enabled: true,
    currentRate: 180,
    targetRate: 220,
    confidence: 90,
    minimumConfidence: 70,
    adjustmentWeight: 0.5,
    maximumIncreasePercent: 20,
    maximumDecreasePercent: 15,
    snapshotExpiresAt: validUntil,
    now,
    ...overrides,
  };
}

test("V1 blends the canonical rate toward the competitive target", () => {
  assert.deepEqual(applyMarketCompetitionPricing(baseline()), {
    rate: 200,
    applied: true,
    reason: "APPLIED",
  });
});

test("V1 never applies market pricing when the host disabled it", () => {
  assert.deepEqual(
    applyMarketCompetitionPricing(baseline({ enabled: false })),
    {
      rate: 180,
      applied: false,
      reason: "DISABLED",
    }
  );
});

test("V1 falls back to the certified engine when confidence is insufficient", () => {
  assert.deepEqual(
    applyMarketCompetitionPricing(baseline({ confidence: 69.99 })),
    {
      rate: 180,
      applied: false,
      reason: "LOW_CONFIDENCE",
    }
  );
});

test("V1 falls back to the certified engine when the snapshot expired", () => {
  assert.deepEqual(
    applyMarketCompetitionPricing(
      baseline({ snapshotExpiresAt: new Date("2026-09-22T11:59:59.999Z") })
    ),
    {
      rate: 180,
      applied: false,
      reason: "EXPIRED_SNAPSHOT",
    }
  );
});

test("V1 caps upward adjustments before downstream guardrails", () => {
  assert.deepEqual(
    applyMarketCompetitionPricing(
      baseline({
        currentRate: 100,
        targetRate: 200,
        adjustmentWeight: 1,
        maximumIncreasePercent: 10,
      })
    ),
    {
      rate: 110,
      applied: true,
      reason: "APPLIED",
    }
  );
});

test("V1 caps downward adjustments before downstream guardrails", () => {
  assert.deepEqual(
    applyMarketCompetitionPricing(
      baseline({
        currentRate: 100,
        targetRate: 40,
        adjustmentWeight: 1,
        maximumDecreasePercent: 15,
      })
    ),
    {
      rate: 85,
      applied: true,
      reason: "APPLIED",
    }
  );
});

test("V1 rejects invalid market values instead of contaminating pricing", () => {
  assert.deepEqual(
    applyMarketCompetitionPricing(baseline({ targetRate: 0 })),
    {
      rate: 180,
      applied: false,
      reason: "INVALID_INPUT",
    }
  );
});

test("V1 rejects unsafe negative adjustment limits", () => {
  assert.deepEqual(
    applyMarketCompetitionPricing(
      baseline({ maximumIncreasePercent: -1 })
    ),
    {
      rate: 180,
      applied: false,
      reason: "INVALID_INPUT",
    }
  );
});
