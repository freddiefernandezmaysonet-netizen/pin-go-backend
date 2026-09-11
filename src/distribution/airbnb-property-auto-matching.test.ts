import assert from "node:assert/strict";
import test from "node:test";

import {
  airbnbPropertyNameSimilarity,
  corroborateAirbnbPropertyMatch,
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
    postalCode: "00771",
    maxGuests: 2,
    ...overrides,
  };
}

function listing(
  overrides: Partial<AirbnbListingMatchInput> = {}
): AirbnbListingMatchInput {
  return {
    id: "551126434553599406",
    title: "Casa Collores",
    city: "Collores",
    countryCode: "PR",
    occupancies: [1, 2],
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

test("auto-matches Casa Collores when the summary is a unique exact candidate", () => {
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
  assert.equal(result.decisions[0]?.candidateListingId, "551126434553599406");
  assert.equal(result.decisions[0]?.score, 95);
  assert.ok(result.decisions[0]?.reasons.includes("NAME_EXACT"));
  assert.ok(result.decisions[0]?.reasons.includes("CITY_MATCH"));
  assert.ok(result.decisions[0]?.reasons.includes("COUNTRY_MATCH"));
});

test("occupancy options are not treated as exact person capacity", () => {
  const decision = matchAirbnbPropertyPortfolio({
    properties: [property({ maxGuests: 2 })],
    listings: [listing({ occupancies: [1, 2, 3, 4] })],
  }).decisions[0]!;

  assert.equal(decision.status, "AUTO_MATCH");
  assert.equal(decision.score, 95);
  assert.equal(decision.reasons.includes("MAX_GUESTS_MISMATCH"), false);
});

test("known city or country contradictions require review", () => {
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

test("listing details corroborate Las Piedras vs Collores with postal code and person capacity", () => {
  const pinGoProperty = property({ city: "Las Piedras", postalCode: "00771", maxGuests: 2 });
  const candidate = listing({ city: "Collores", occupancies: [1, 2, 3, 4] });
  const initial = matchAirbnbPropertyPortfolio({
    properties: [pinGoProperty],
    listings: [candidate],
  }).decisions[0]!;

  assert.equal(initial.status, "REVIEW_REQUIRED");
  const corroborated = corroborateAirbnbPropertyMatch({
    property: pinGoProperty,
    listing: candidate,
    decision: initial,
    details: {
      listingId: candidate.id,
      personCapacity: 2,
      city: "Collores",
      state: "Puerto Rico",
      postalCode: "00771",
      countryCode: "PR",
      latitude: 18.19,
      longitude: -65.87,
    },
  });

  assert.equal(corroborated.status, "AUTO_MATCH");
  assert.equal(corroborated.confidence, "HIGH");
  assert.ok(corroborated.reasons.includes("POSTAL_CODE_MATCH"));
  assert.ok(corroborated.reasons.includes("PERSON_CAPACITY_MATCH"));
  assert.ok(corroborated.reasons.includes("CITY_MISMATCH_CORROBORATED"));
});

test("postal or exact person-capacity contradictions remain review required", () => {
  const pinGoProperty = property({ city: "Las Piedras" });
  const candidate = listing({ city: "Collores" });
  const initial = matchAirbnbPropertyPortfolio({
    properties: [pinGoProperty],
    listings: [candidate],
  }).decisions[0]!;

  const postalMismatch = corroborateAirbnbPropertyMatch({
    property: pinGoProperty,
    listing: candidate,
    decision: initial,
    details: {
      listingId: candidate.id,
      personCapacity: 2,
      city: "Collores",
      state: "Puerto Rico",
      postalCode: "00901",
      countryCode: "PR",
      latitude: null,
      longitude: null,
    },
  });
  assert.equal(postalMismatch.status, "REVIEW_REQUIRED");
  assert.ok(postalMismatch.reasons.includes("POSTAL_CODE_MISMATCH"));

  const capacityMismatch = corroborateAirbnbPropertyMatch({
    property: pinGoProperty,
    listing: candidate,
    decision: initial,
    details: {
      listingId: candidate.id,
      personCapacity: 3,
      city: "Collores",
      state: "Puerto Rico",
      postalCode: "00771",
      countryCode: "PR",
      latitude: null,
      longitude: null,
    },
  });
  assert.equal(capacityMismatch.status, "REVIEW_REQUIRED");
  assert.ok(capacityMismatch.reasons.includes("PERSON_CAPACITY_MISMATCH"));
});

test("a close runner-up prevents an automatic match and details corroboration", () => {
  const pinGoProperty = property({ city: "Las Piedras" });
  const candidates = [
    listing({ id: "551126434553599406", city: "Collores" }),
    listing({ id: "551126434553599407", city: "Collores" }),
  ];
  const initial = matchAirbnbPropertyPortfolio({
    properties: [pinGoProperty],
    listings: candidates,
  }).decisions[0]!;

  assert.equal(initial.status, "REVIEW_REQUIRED");
  assert.ok(initial.reasons.includes("AMBIGUOUS_RUNNER_UP"));
  const corroborated = corroborateAirbnbPropertyMatch({
    property: pinGoProperty,
    listing: candidates[0]!,
    decision: initial,
    details: {
      listingId: candidates[0]!.id,
      personCapacity: 2,
      city: "Collores",
      state: "Puerto Rico",
      postalCode: "00771",
      countryCode: "PR",
      latitude: null,
      longitude: null,
    },
  });
  assert.equal(corroborated.status, "REVIEW_REQUIRED");
});

test("weak candidates remain unmatched", () => {
  const result = matchAirbnbPropertyPortfolio({
    properties: [property()],
    listings: [
      listing({
        id: "551126434553599499",
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

test("one Airbnb listing can never be eligible for two Pin&Go properties", () => {
  const result = matchAirbnbPropertyPortfolio({
    properties: [
      property({ id: "property-1", city: "Las Piedras" }),
      property({ id: "property-2", city: "Las Piedras" }),
    ],
    listings: [listing({ city: "Collores" })],
  });

  assert.equal(result.summary.autoMatched, 0);
  assert.equal(result.summary.reviewRequired, 2);
  for (const decision of result.decisions) {
    assert.equal(decision.status, "REVIEW_REQUIRED");
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
