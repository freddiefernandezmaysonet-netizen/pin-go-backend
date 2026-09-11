import assert from "node:assert/strict";
import test from "node:test";

import {
  airbnbPropertyNameSimilarity,
  matchAirbnbPropertyPortfolio,
  type AirbnbListingMatchInput,
  type PinGoPropertyMatchInput,
} from "./airbnb-property-auto-matching.js";

function property(
  overrides: Partial<PinGoPropertyMatchInput> = {}
): PinGoPropertyMatchInput {
  return {
    id: "property-1",
    name: "Casa Collores",
    publicTitle: null,
    city: "Collores",
    country: "Puerto Rico",
    maxGuests: 2,
    ...overrides,
  };
}

function listing(
  overrides: Partial<AirbnbListingMatchInput> = {}
): AirbnbListingMatchInput {
  return {
    id: "listing-1",
    title: "Casa Collores",
    city: "Collores",
    countryCode: "PR",
    occupancies: [1, 2],
    ...overrides,
  };
}

test("normalizes case accents punctuation and protects numeric identity", () => {
  assert.equal(airbnbPropertyNameSimilarity("Casa Collorés", "CASA COLLORES"), 1);
  assert.ok(
    airbnbPropertyNameSimilarity(
      "Casa Collores",
      "Casa Collores - Mountain Retreat"
    ) >= 0.9
  );
  assert.ok(airbnbPropertyNameSimilarity("Villa 1", "Villa 2") <= 0.55);
  assert.ok(airbnbPropertyNameSimilarity("Villa", "Villa 2") <= 0.75);
});

test("auto-matches Casa Collores when the listing is a unique exact candidate", () => {
  const result = matchAirbnbPropertyPortfolio({
    properties: [property()],
    listings: [listing()],
  });

  assert.deepEqual(result.summary, {
    propertiesConsidered: 1,
    listingsConsidered: 1,
    autoMatched: 1,
    reviewRequired: 0,
    unmatched: 0,
  });
  assert.equal(result.decisions[0]?.status, "AUTO_MATCH");
  assert.equal(result.decisions[0]?.confidence, "HIGH");
  assert.equal(result.decisions[0]?.candidateListingId, "listing-1");
  assert.equal(result.decisions[0]?.score, 100);
  assert.ok(result.decisions[0]?.reasons.includes("NAME_EXACT"));
  assert.ok(result.decisions[0]?.reasons.includes("CITY_MATCH"));
  assert.ok(result.decisions[0]?.reasons.includes("COUNTRY_MATCH"));
  assert.ok(result.decisions[0]?.reasons.includes("MAX_GUESTS_MATCH"));
});

test("missing maxGuests does not block a unique exact location match", () => {
  const result = matchAirbnbPropertyPortfolio({
    properties: [property({ maxGuests: null })],
    listings: [listing()],
  });

  assert.equal(result.decisions[0]?.status, "AUTO_MATCH");
  assert.equal(result.decisions[0]?.score, 95);
  assert.ok(result.decisions[0]?.reasons.includes("MAX_GUESTS_UNKNOWN"));
});

test("city or country contradictions require review instead of automatic matching", () => {
  const cityMismatch = matchAirbnbPropertyPortfolio({
    properties: [property()],
    listings: [listing({ city: "San Juan" })],
  }).decisions[0]!;
  assert.equal(cityMismatch.status, "REVIEW_REQUIRED");
  assert.ok(cityMismatch.reasons.includes("CITY_MISMATCH"));

  const countryMismatch = matchAirbnbPropertyPortfolio({
    properties: [property()],
    listings: [listing({ countryCode: "US" })],
  }).decisions[0]!;
  assert.equal(countryMismatch.status, "REVIEW_REQUIRED");
  assert.ok(countryMismatch.reasons.includes("COUNTRY_MISMATCH"));
});

test("a close runner-up prevents an automatic match", () => {
  const result = matchAirbnbPropertyPortfolio({
    properties: [property()],
    listings: [
      listing({ id: "listing-1" }),
      listing({ id: "listing-2", title: "Casa Collores" }),
    ],
  });

  assert.equal(result.decisions[0]?.status, "REVIEW_REQUIRED");
  assert.equal(result.decisions[0]?.candidateListingId, "listing-1");
  assert.equal(result.decisions[0]?.runnerUpScore, 100);
  assert.ok(result.decisions[0]?.reasons.includes("AMBIGUOUS_RUNNER_UP"));
});

test("weak candidates remain unmatched", () => {
  const result = matchAirbnbPropertyPortfolio({
    properties: [property()],
    listings: [
      listing({
        id: "listing-other",
        title: "Ocean View Apartment",
        city: "San Juan",
        countryCode: "PR",
        occupancies: [1, 2, 3, 4],
      }),
    ],
  });

  assert.equal(result.decisions[0]?.status, "UNMATCHED");
  assert.equal(result.decisions[0]?.candidateListingId, null);
  assert.equal(result.summary.unmatched, 1);
});

test("one Airbnb listing can never be auto-matched to two Pin&Go properties", () => {
  const result = matchAirbnbPropertyPortfolio({
    properties: [
      property({ id: "property-1" }),
      property({ id: "property-2" }),
    ],
    listings: [listing()],
  });

  assert.equal(result.summary.autoMatched, 0);
  assert.equal(result.summary.reviewRequired, 2);
  for (const decision of result.decisions) {
    assert.equal(decision.status, "REVIEW_REQUIRED");
    assert.equal(decision.candidateListingId, "listing-1");
    assert.ok(decision.reasons.includes("LISTING_CONFLICT"));
  }
});

test("publicTitle is the preferred matching name when configured", () => {
  const result = matchAirbnbPropertyPortfolio({
    properties: [
      property({
        name: "Internal Property 17",
        publicTitle: "Casa Collores",
      }),
    ],
    listings: [listing()],
  });

  assert.equal(result.decisions[0]?.status, "AUTO_MATCH");
  assert.equal(result.decisions[0]?.score, 100);
});
