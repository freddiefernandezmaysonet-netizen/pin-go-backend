import assert from "node:assert/strict";
import test from "node:test";

import type {
  MarketComparableCandidate,
  MarketDailyObservation,
} from "./market-pricing-provider.contract";
import {
  deriveMarketPricingSnapshot,
  type MarketPricingSnapshotDerivationInput,
} from "./market-pricing-snapshot-derivation.policy";

function observation(
  overrides: Partial<MarketDailyObservation> = {}
): MarketDailyObservation {
  return {
    stayDate: "2026-10-01",
    currency: "USD",
    sampleSize: 8,
    availableCount: 4,
    lowerRate: 160,
    medianRate: 200,
    upperRate: 240,
    providerSuggestedRate: 205,
    ...overrides,
  };
}

function comparable(
  similarityScore: number,
  id = `listing-${similarityScore}`
): MarketComparableCandidate {
  return {
    externalListingId: id,
    listingName: null,
    latitude: null,
    longitude: null,
    distanceKm: null,
    similarityScore,
    propertyType: null,
    bedrooms: null,
    bathrooms: null,
    maxGuests: null,
    amenityCodes: [],
    reviewScore: null,
    reviewCount: null,
    attributes: null,
  };
}

function baseline(
  overrides: Partial<MarketPricingSnapshotDerivationInput> = {}
): MarketPricingSnapshotDerivationInput {
  return {
    observation: observation(),
    comparables: [comparable(90)],
    strategy: "BALANCED",
    position: "COMPETITIVE",
    aggressiveness: "MODERATE",
    ...overrides,
  };
}

function target(input: MarketPricingSnapshotDerivationInput): number {
  const result = deriveMarketPricingSnapshot(input);
  assert.equal(result.derived, true);
  if (!result.derived) throw new Error("Expected a derived snapshot.");
  return result.targetRate;
}

test("V1 derives a neutral competitive target from the market median", () => {
  const result = deriveMarketPricingSnapshot(baseline());
  assert.equal(result.derived, true);
  if (!result.derived) throw new Error("Expected a derived snapshot.");
  assert.equal(result.targetRate, 200);
  assert.equal(result.evidence.marketTightness, 0);
});

test("V1 ignores the provider suggested rate when deriving the target", () => {
  const lowSuggestion = target(
    baseline({ observation: observation({ providerSuggestedRate: 1 }) })
  );
  const highSuggestion = target(
    baseline({ observation: observation({ providerSuggestedRate: 9999 }) })
  );
  assert.equal(lowSuggestion, highSuggestion);
});

test("V1 strategy prioritizes revenue more in a tight market", () => {
  const tightMarket = observation({ availableCount: 0 });
  const occupancy = target(baseline({ observation: tightMarket, strategy: "OCCUPANCY" }));
  const balanced = target(baseline({ observation: tightMarket, strategy: "BALANCED" }));
  const revenue = target(baseline({ observation: tightMarket, strategy: "REVENUE" }));
  assert.deepEqual({ occupancy, balanced, revenue }, { occupancy: 206, balanced: 212, revenue: 220 });
});

test("V1 strategy prioritizes occupancy more in a soft market", () => {
  const softMarket = observation({ availableCount: 8 });
  const occupancy = target(baseline({ observation: softMarket, strategy: "OCCUPANCY" }));
  const balanced = target(baseline({ observation: softMarket, strategy: "BALANCED" }));
  const revenue = target(baseline({ observation: softMarket, strategy: "REVENUE" }));
  assert.deepEqual({ occupancy, balanced, revenue }, { occupancy: 184, balanced: 188, revenue: 194 });
});

test("V1 host position selects value, competitive or premium placement", () => {
  const value = target(baseline({ position: "VALUE" }));
  const competitive = target(baseline({ position: "COMPETITIVE" }));
  const premium = target(baseline({ position: "PREMIUM" }));
  assert.deepEqual({ value, competitive, premium }, { value: 190, competitive: 200, premium: 210 });
});

test("V1 aggressiveness scales the market response predictably", () => {
  const tightMarket = observation({ availableCount: 0 });
  const conservative = target(baseline({ observation: tightMarket, aggressiveness: "CONSERVATIVE" }));
  const moderate = target(baseline({ observation: tightMarket, aggressiveness: "MODERATE" }));
  const aggressive = target(baseline({ observation: tightMarket, aggressiveness: "AGGRESSIVE" }));
  assert.deepEqual({ conservative, moderate, aggressive }, { conservative: 206, moderate: 212, aggressive: 218 });
});

test("V1 never derives a target above the observed upper market bound", () => {
  assert.equal(
    target(
      baseline({
        observation: observation({ availableCount: 0, upperRate: 220 }),
        strategy: "REVENUE",
        position: "PREMIUM",
        aggressiveness: "AGGRESSIVE",
      })
    ),
    220
  );
});

test("V1 derives high confidence from sufficient, similar and stable evidence", () => {
  const result = deriveMarketPricingSnapshot(
    baseline({
      observation: observation({ lowerRate: 180, upperRate: 220 }),
      comparables: [comparable(90, "one"), comparable(90, "two")],
    })
  );
  assert.equal(result.derived, true);
  if (!result.derived) throw new Error("Expected a derived snapshot.");
  assert.equal(result.confidence, 92);
  assert.deepEqual(
    {
      sample: result.evidence.sampleConfidence,
      similarity: result.evidence.similarityConfidence,
      stability: result.evidence.stabilityConfidence,
    },
    { sample: 40, similarity: 36, stability: 16 }
  );
});

test("V1 keeps confidence below the default threshold without comparables", () => {
  const result = deriveMarketPricingSnapshot(
    baseline({
      observation: observation({ lowerRate: 180, upperRate: 220 }),
      comparables: [],
    })
  );
  assert.equal(result.derived, true);
  if (!result.derived) throw new Error("Expected a derived snapshot.");
  assert.equal(result.confidence, 56);
  assert.ok(result.confidence < 70);
});

test("V1 lowers confidence when the comparable set is weak", () => {
  const strong = deriveMarketPricingSnapshot(
    baseline({ comparables: [comparable(95)] })
  );
  const weak = deriveMarketPricingSnapshot(
    baseline({ comparables: [comparable(40)] })
  );
  assert.equal(strong.derived, true);
  assert.equal(weak.derived, true);
  if (!strong.derived || !weak.derived) {
    throw new Error("Expected derived snapshots.");
  }
  assert.ok(strong.confidence > weak.confidence);
});

test("V1 rejects invalid sample evidence instead of deriving a price", () => {
  assert.deepEqual(
    deriveMarketPricingSnapshot(
      baseline({ observation: observation({ sampleSize: 0 }) })
    ),
    { derived: false, reason: "INVALID_INPUT" }
  );
});
