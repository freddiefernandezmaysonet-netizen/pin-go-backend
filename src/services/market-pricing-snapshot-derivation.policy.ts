import type {
  MarketComparableCandidate,
  MarketDailyObservation,
} from "./market-pricing-provider.contract";

export type MarketPricingStrategy = "OCCUPANCY" | "BALANCED" | "REVENUE";
export type MarketPricingPosition = "VALUE" | "COMPETITIVE" | "PREMIUM";
export type MarketPricingAggressiveness =
  | "CONSERVATIVE"
  | "MODERATE"
  | "AGGRESSIVE";

export type MarketPricingSnapshotDerivationInput = {
  observation: MarketDailyObservation;
  comparables: MarketComparableCandidate[];
  strategy: MarketPricingStrategy;
  position: MarketPricingPosition;
  aggressiveness: MarketPricingAggressiveness;
};

export type MarketPricingSnapshotEvidence = {
  referenceRate: number;
  availabilityRatio: number;
  marketTightness: number;
  positionFactor: number;
  demandAdjustmentPercent: number;
  sampleConfidence: number;
  similarityConfidence: number;
  stabilityConfidence: number;
  averageSimilarityScore: number | null;
  priceSpreadRatio: number | null;
  comparableCount: number;
};

export type MarketPricingSnapshotDerivationResult =
  | {
      derived: true;
      targetRate: number;
      confidence: number;
      evidence: MarketPricingSnapshotEvidence;
    }
  | {
      derived: false;
      reason: "INVALID_INPUT";
    };

const POSITION_FACTORS: Record<MarketPricingPosition, number> = {
  VALUE: 0.95,
  COMPETITIVE: 1,
  PREMIUM: 1.05,
};

const AGGRESSIVENESS_FACTORS: Record<MarketPricingAggressiveness, number> = {
  CONSERVATIVE: 0.5,
  MODERATE: 1,
  AGGRESSIVE: 1.5,
};

const STRATEGY_DEMAND_FACTORS: Record<
  MarketPricingStrategy,
  { tightMarket: number; softMarket: number }
> = {
  OCCUPANCY: { tightMarket: 0.03, softMarket: 0.08 },
  BALANCED: { tightMarket: 0.06, softMarket: 0.06 },
  REVENUE: { tightMarket: 0.1, softMarket: 0.03 },
};

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function round(value: number, decimals: number): number {
  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function hasValidInput(input: MarketPricingSnapshotDerivationInput): boolean {
  const { observation, comparables, strategy, position, aggressiveness } = input;

  if (!(strategy in STRATEGY_DEMAND_FACTORS)) return false;
  if (!(position in POSITION_FACTORS)) return false;
  if (!(aggressiveness in AGGRESSIVENESS_FACTORS)) return false;
  if (!Number.isInteger(observation.sampleSize) || observation.sampleSize <= 0) {
    return false;
  }
  if (
    !Number.isInteger(observation.availableCount) ||
    observation.availableCount < 0 ||
    observation.availableCount > observation.sampleSize
  ) {
    return false;
  }
  if (!isFinitePositive(observation.medianRate)) return false;
  if (
    observation.lowerRate !== null &&
    (!isFinitePositive(observation.lowerRate) ||
      observation.lowerRate > observation.medianRate)
  ) {
    return false;
  }
  if (
    observation.upperRate !== null &&
    (!isFinitePositive(observation.upperRate) ||
      observation.upperRate < observation.medianRate)
  ) {
    return false;
  }
  if (!Array.isArray(comparables)) return false;

  return comparables.every(
    (comparable) =>
      Number.isFinite(comparable.similarityScore) &&
      comparable.similarityScore >= 0 &&
      comparable.similarityScore <= 100
  );
}

function calculateDemandAdjustment(input: {
  marketTightness: number;
  strategy: MarketPricingStrategy;
  aggressiveness: MarketPricingAggressiveness;
}): number {
  const factor = STRATEGY_DEMAND_FACTORS[input.strategy];
  const directionalFactor =
    input.marketTightness >= 0 ? factor.tightMarket : factor.softMarket;

  return (
    input.marketTightness *
    directionalFactor *
    AGGRESSIVENESS_FACTORS[input.aggressiveness]
  );
}

function calculateSimilarityConfidence(
  comparables: MarketComparableCandidate[]
): { confidence: number; average: number | null } {
  if (comparables.length === 0) {
    return { confidence: 0, average: null };
  }

  const average =
    comparables.reduce((sum, item) => sum + item.similarityScore, 0) /
    comparables.length;

  return {
    confidence: (average / 100) * 40,
    average,
  };
}

function calculateStabilityConfidence(
  observation: MarketDailyObservation
): { confidence: number; spreadRatio: number | null } {
  if (observation.lowerRate === null || observation.upperRate === null) {
    return { confidence: 10, spreadRatio: null };
  }

  const spreadRatio =
    (observation.upperRate - observation.lowerRate) /
    observation.medianRate;
  const stability = 1 - clamp(spreadRatio, 0, 1);

  return {
    confidence: stability * 20,
    spreadRatio,
  };
}

export function deriveMarketPricingSnapshot(
  input: MarketPricingSnapshotDerivationInput
): MarketPricingSnapshotDerivationResult {
  if (!hasValidInput(input)) {
    return { derived: false, reason: "INVALID_INPUT" };
  }

  const { observation, comparables, strategy, position, aggressiveness } = input;
  const availabilityRatio =
    observation.availableCount / observation.sampleSize;
  const marketTightness = clamp((0.5 - availabilityRatio) * 2, -1, 1);
  const positionFactor = POSITION_FACTORS[position];
  const demandAdjustment = calculateDemandAdjustment({
    marketTightness,
    strategy,
    aggressiveness,
  });

  const unboundedTarget =
    observation.medianRate * positionFactor * (1 + demandAdjustment);
  const minimumRate = observation.lowerRate ?? 0.01;
  const maximumRate = observation.upperRate ?? Number.MAX_SAFE_INTEGER;
  const targetRate = round(
    clamp(unboundedTarget, minimumRate, maximumRate),
    2
  );

  const sampleConfidence =
    clamp(observation.sampleSize / 8, 0, 1) * 40;
  const similarity = calculateSimilarityConfidence(comparables);
  const stability = calculateStabilityConfidence(observation);
  const confidence = round(
    clamp(
      sampleConfidence + similarity.confidence + stability.confidence,
      0,
      100
    ),
    2
  );

  return {
    derived: true,
    targetRate,
    confidence,
    evidence: {
      referenceRate: observation.medianRate,
      availabilityRatio: round(availabilityRatio, 4),
      marketTightness: round(marketTightness, 4),
      positionFactor,
      demandAdjustmentPercent: round(demandAdjustment * 100, 2),
      sampleConfidence: round(sampleConfidence, 2),
      similarityConfidence: round(similarity.confidence, 2),
      stabilityConfidence: round(stability.confidence, 2),
      averageSimilarityScore:
        similarity.average === null ? null : round(similarity.average, 2),
      priceSpreadRatio:
        stability.spreadRatio === null
          ? null
          : round(stability.spreadRatio, 4),
      comparableCount: comparables.length,
    },
  };
}
