export type MarketCompetitionPricingInput = {
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

export type MarketCompetitionPricingReason =
  | "APPLIED"
  | "DISABLED"
  | "LOW_CONFIDENCE"
  | "EXPIRED_SNAPSHOT"
  | "INVALID_INPUT";

export type MarketCompetitionPricingResult = {
  rate: number;
  applied: boolean;
  reason: MarketCompetitionPricingReason;
};

function toMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function unchangedResult(
  currentRate: number,
  reason: Exclude<MarketCompetitionPricingReason, "APPLIED">
): MarketCompetitionPricingResult {
  return {
    rate: toMoney(currentRate),
    applied: false,
    reason,
  };
}

export function applyMarketCompetitionPricing(
  input: MarketCompetitionPricingInput
): MarketCompetitionPricingResult {
  if (!input.enabled) {
    return unchangedResult(input.currentRate, "DISABLED");
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
    input.maximumIncreasePercent < 0 ||
    !Number.isFinite(input.maximumDecreasePercent) ||
    input.maximumDecreasePercent < 0 ||
    input.maximumDecreasePercent > 100 ||
    !Number.isFinite(input.snapshotExpiresAt.getTime()) ||
    !Number.isFinite(input.now.getTime())
  ) {
    return unchangedResult(input.currentRate, "INVALID_INPUT");
  }

  if (input.snapshotExpiresAt.getTime() <= input.now.getTime()) {
    return unchangedResult(input.currentRate, "EXPIRED_SNAPSHOT");
  }

  if (input.confidence < input.minimumConfidence) {
    return unchangedResult(input.currentRate, "LOW_CONFIDENCE");
  }

  const adjustmentWeight = Math.min(
    1,
    Math.max(0, input.adjustmentWeight)
  );
  const proposedRate =
    input.currentRate +
    adjustmentWeight * (input.targetRate - input.currentRate);
  const maximumRate =
    input.currentRate * (1 + input.maximumIncreasePercent / 100);
  const minimumRate =
    input.currentRate * (1 - input.maximumDecreasePercent / 100);
  const rate = toMoney(
    Math.min(maximumRate, Math.max(minimumRate, proposedRate))
  );
  const applied = rate !== toMoney(input.currentRate);

  return {
    rate,
    applied,
    reason: applied ? "APPLIED" : "INVALID_INPUT",
  };
}
