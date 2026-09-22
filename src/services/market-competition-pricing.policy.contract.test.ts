import assert from "node:assert/strict";
import test from "node:test";

type MarketCompetitionContractInput = {
  enabled: boolean;
  currentRate: number;
  targetRate: number;
  confidence: number;
  minimumConfidence: number;
  adjustmentWeight: number;
  maximumIncreasePercent: number;
  maximumDecreasePercent: number;
  snapshotExpiresAt: Date;
  now: Date;
};

type MarketCompetitionContractResult = {
  rate: number;
  applied: boolean;
  reason:
    | "APPLIED"
    | "DISABLED"
    | "LOW_CONFIDENCE"
    | "EXPIRED_SNAPSHOT"
    | "INVALID_INPUT";
};

function toMoney(value: number) {
  return Math.round(value * 100) / 100;
}

/**
 * Executable V1 contract.
 *
 * This reference is intentionally local to keep the first TDD commit green.
 * The implementation commit must export the production policy and replace
 * this reference with that import without changing these expectations.
 */
function applyMarketCompetitionContract(
  input: MarketCompetitionContractInput
): MarketCompetitionContractResult {
  if (!input.enabled) {
    return { rate: toMoney(input.currentRate), applied: false, reason: "DISABLED" };
  }

  if (
    !Number.isFinite(input.currentRate) ||
    input.currentRate <= 0 ||
    !Number.isFinite(input.targetRate) ||
    input.targetRate <= 0 ||
    !Number.isFinite(input.confidence) ||
    !Number.isFinite(input.minimumConfidence) ||
    !Number.isFinite(input.adjustmentWeight) ||
    !Number.isFinite(input.maximumIncreasePercent) ||
    !Number.isFinite(input.maximumDecreasePercent)
  ) {
    return {
      rate: toMoney(input.currentRate),
      applied: false,
      reason: "INVALID_INPUT",
    };
  }

  if (input.snapshotExpiresAt.getTime() <= input.now.getTime()) {
    return {
      rate: toMoney(input.currentRate),
      applied: false,
      reason: "EXPIRED_SNAPSHOT",
    };
  }

  if (input.confidence < input.minimumConfidence) {
    return {
      rate: toMoney(input.currentRate),
      applied: false,
      reason: "LOW_CONFIDENCE",
    };
  }

  const weight = Math.min(1, Math.max(0, input.adjustmentWeight));
  const proposedRate =
    input.currentRate + weight * (input.targetRate - input.currentRate);
  const maximumRate =
    input.currentRate * (1 + input.maximumIncreasePercent / 100);
  const minimumRate =
    input.currentRate * (1 - input.maximumDecreasePercent / 100);
  const rate = toMoney(
    Math.min(maximumRate, Math.max(minimumRate, proposedRate))
  );

  return {
    rate,
    applied: rate !== toMoney(input.currentRate),
    reason: rate !== toMoney(input.currentRate) ? "APPLIED" : "INVALID_INPUT",
  };
}

const now = new Date("2026-09-22T12:00:00.000Z");
const validUntil = new Date("2026-09-23T12:00:00.000Z");

function baseline(
  overrides: Partial<MarketCompetitionContractInput> = {}
): MarketCompetitionContractInput {
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
  assert.deepEqual(applyMarketCompetitionContract(baseline()), {
    rate: 200,
    applied: true,
    reason: "APPLIED",
  });
});

test("V1 never applies market pricing when the host disabled it", () => {
  assert.deepEqual(
    applyMarketCompetitionContract(baseline({ enabled: false })),
    {
      rate: 180,
      applied: false,
      reason: "DISABLED",
    }
  );
});

test("V1 falls back to the certified engine when confidence is insufficient", () => {
  assert.deepEqual(
    applyMarketCompetitionContract(baseline({ confidence: 69.99 })),
    {
      rate: 180,
      applied: false,
      reason: "LOW_CONFIDENCE",
    }
  );
});

test("V1 falls back to the certified engine when the snapshot expired", () => {
  assert.deepEqual(
    applyMarketCompetitionContract(
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
    applyMarketCompetitionContract(
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
    applyMarketCompetitionContract(
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
    applyMarketCompetitionContract(baseline({ targetRate: 0 })),
    {
      rate: 180,
      applied: false,
      reason: "INVALID_INPUT",
    }
  );
});
