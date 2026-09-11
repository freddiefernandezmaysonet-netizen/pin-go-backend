import assert from "node:assert/strict";
import test from "node:test";

import {
  airbnbPropertyNameSimilarity,
  corroborateAirbnbPropertyMatch,
  matchAirbnbPropertyPortfolio,
  shouldCorroborateAirbnbPropertyMatch,
  type AirbnbListingDetailsMatchInput,
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
    postalCode: "00771",
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

function details(
  overrides: Partial<AirbnbListingDetailsMatchInput> = {}
): AirbnbListingDetailsMatchInput {
  return {
    id: "listing-1",
    name: "Casa Collores",
    personCapacity: 2,
    city: "Collores",
    state: "Puerto Rico",
    street: "Development address",
    postalCode: "00771",
    countryCode: "PR",
    latitude: null,
    longitude: null,
    ...overrides,
  };
}

test("normalizes text but protects numeric and generic-name identity", () => {
  assert.equal(airbnbPropertyNameSimilarity("Casa Collorés", "CASA COLLORES"), 1);
  assert.ok(
    airbnbPropertyNameSimilarity(
      "Casa Collores",
      "Casa Collores - Mountain Retreat"
    ) >= 0.9
  );
  assert.ok(airbnbPropertyNameSimilarity("Villa 1", "Villa 2") <= 0.55);
  assert.ok(airbnbPropertyNameSimilarity("Villa", "Villa del Mar") < 0.9);
});

test("auto-matches a unique exact summary without treating occupancy options as capacity", () => {
  const result = matchAirbnbPropertyPortfolio({
    properties: [property()],
    listings: [listing({ occupancies: [1, 2, 3, 4] })],
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
  assert.equal(result.decisions[0]?.score, 95);
  assert.ok(result.decisions[0]?.reasons.includes("NAME_EXACT"));
  assert.ok(result.decisions[0]?.reasons.includes("CITY_MATCH"));
  assert.ok(result.decisions[0]?.reasons.includes("COUNTRY_MATCH"));
  assert.ok(result.decisions[0]?.reasons.includes("OCCUPANCY_OPTIONS_PRESENT"));
  assert.equal(result.decisions[0]?.reasons.some((reason) => reason.startsWith("MAX_GUESTS_")), false);
});

test("missing maxGuests does not block a unique exact location match", () => {
  const result = matchAirbnbPropertyPortfolio({
    properties: [property({ maxGuests: null })],
    listings: [listing()],
  });

  assert.equal(result.decisions[0]?.status, "AUTO_MATCH");
  assert.equal(result.decisions[0]?.score, 95);
});

test("known city or country contradictions require review", () => {
  const cityMismatch = matchAirbnbPropertyPortfolio({
    properties: [property()],
    listings: [listing({ city: "San Juan" })],
  }).decisions[0]!;
  assert.equal(cityMismatch.status, "REVIEW_REQUIRED");
  assert.equal(cityMismatch.score, 80);
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
  assert.equal(result.decisions[0]?.runnerUpScore, 95);
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

test("uses whichever Pin&Go title is the stronger identity signal", () => {
  const result = matchAirbnbPropertyPortfolio({
    properties: [
      property({
        name: "Casa Collores",
        publicTitle: "Mountain Escape by Pin&Go",
      }),
    ],
    listings: [listing()],
  });

  assert.equal(result.decisions[0]?.status, "AUTO_MATCH");
  assert.equal(result.decisions[0]?.score, 95);
});

test("Las Piedras versus Collores can be corroborated by exact postal code and person capacity", () => {
  const target = property({ city: "Las Piedras", postalCode: "00771", maxGuests: 2 });
  const portfolio = matchAirbnbPropertyPortfolio({
    properties: [target],
    listings: [listing({ city: "Collores", occupancies: [1, 2] })],
  });
  const initial = portfolio.decisions[0]!;

  assert.equal(initial.status, "REVIEW_REQUIRED");
  assert.equal(initial.score, 80);
  assert.equal(shouldCorroborateAirbnbPropertyMatch({ property: target, decision: initial }), true);

  const corroborated = corroborateAirbnbPropertyMatch({
    property: target,
    decision: initial,
    details: details({ postalCode: "00771", personCapacity: 2 }),
    competingDecisions: portfolio.decisions,
  });

  assert.equal(corroborated.status, "AUTO_MATCH");
  assert.equal(corroborated.confidence, "HIGH");
  assert.equal(corroborated.score, 95);
  assert.ok(corroborated.reasons.includes("POSTAL_CODE_MATCH"));
  assert.ok(corroborated.reasons.includes("PERSON_CAPACITY_MATCH"));
  assert.ok(corroborated.reasons.includes("LOCATION_CORROBORATED_BY_POSTAL_CODE"));
});

test("postal normalization preserves leading-zero identity without requiring punctuation parity", () => {
  const target = property({ city: "Las Piedras", postalCode: "00771" });
  const initial = matchAirbnbPropertyPortfolio({
    properties: [target],
    listings: [listing({ city: "Collores" })],
  }).decisions[0]!;

  const corroborated = corroborateAirbnbPropertyMatch({
    property: target,
    decision: initial,
    details: details({ postalCode: "00771-0000" }),
  });

  assert.equal(corroborated.status, "REVIEW_REQUIRED");
  assert.ok(corroborated.reasons.includes("POSTAL_CODE_MISMATCH"));

  const exact = corroborateAirbnbPropertyMatch({
    property: target,
    decision: initial,
    details: details({ postalCode: "00 771" }),
  });
  assert.equal(exact.status, "AUTO_MATCH");
});

test("postal or person-capacity contradictions remain review-required", () => {
  const target = property({ city: "Las Piedras" });
  const initial = matchAirbnbPropertyPortfolio({
    properties: [target],
    listings: [listing({ city: "Collores" })],
  }).decisions[0]!;

  const postalMismatch = corroborateAirbnbPropertyMatch({
    property: target,
    decision: initial,
    details: details({ postalCode: "00999" }),
  });
  assert.equal(postalMismatch.status, "REVIEW_REQUIRED");
  assert.ok(postalMismatch.reasons.includes("POSTAL_CODE_MISMATCH"));

  const capacityMismatch = corroborateAirbnbPropertyMatch({
    property: target,
    decision: initial,
    details: details({ personCapacity: 3 }),
  });
  assert.equal(capacityMismatch.status, "REVIEW_REQUIRED");
  assert.ok(capacityMismatch.reasons.includes("PERSON_CAPACITY_MISMATCH"));
});

test("details fallback is disabled without postal evidence or with an ambiguous runner-up", () => {
  const noPostal = property({ city: "Las Piedras", postalCode: null });
  const noPostalDecision = matchAirbnbPropertyPortfolio({
    properties: [noPostal],
    listings: [listing({ city: "Collores" })],
  }).decisions[0]!;
  assert.equal(
    shouldCorroborateAirbnbPropertyMatch({ property: noPostal, decision: noPostalDecision }),
    false
  );

  const target = property({ city: "Las Piedras" });
  const ambiguous = matchAirbnbPropertyPortfolio({
    properties: [target],
    listings: [
      listing({ id: "listing-1", city: "Collores" }),
      listing({ id: "listing-2", city: "Collores" }),
    ],
  }).decisions[0]!;
  assert.ok(ambiguous.reasons.includes("AMBIGUOUS_RUNNER_UP"));
  assert.equal(
    shouldCorroborateAirbnbPropertyMatch({ property: target, decision: ambiguous }),
    false
  );
});

test("details corroboration refuses a candidate claimed by another property", () => {
  const target = property({ id: "property-1", city: "Las Piedras" });
  const initial = matchAirbnbPropertyPortfolio({
    properties: [target],
    listings: [listing({ city: "Collores" })],
  }).decisions[0]!;
  const competitor = {
    ...initial,
    propertyId: "property-2",
  };

  const result = corroborateAirbnbPropertyMatch({
    property: target,
    decision: initial,
    details: details(),
    competingDecisions: [initial, competitor],
  });
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.ok(result.reasons.includes("LISTING_CONFLICT"));
});
