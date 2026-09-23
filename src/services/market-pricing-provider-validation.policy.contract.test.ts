import assert from "node:assert/strict";
import test from "node:test";

import type {
  MarketPricingProviderRequest,
  MarketPricingProviderResult,
} from "./market-pricing-provider.contract";
import {
  validateMarketPricingProviderResult,
  type MarketPricingProviderValidationIssueCode,
} from "./market-pricing-provider-validation.policy";

const request: MarketPricingProviderRequest = {
  property: {
    propertyId: "property-1",
    latitude: 18.2,
    longitude: -66.5,
    country: "PR",
    region: "Puerto Rico",
    city: "San Juan",
    timezone: "America/Puerto_Rico",
    currency: "USD",
    propertyType: "APARTMENT",
    bedrooms: 2,
    bathrooms: 1,
    maxGuests: 4,
    amenityCodes: ["POOL", "WIFI"],
  },
  dateFrom: "2026-10-01",
  dateToExclusive: "2026-10-04",
  marketRadiusKm: 10,
  maximumComparables: 10,
};

function validResult(): MarketPricingProviderResult {
  return {
    provider: "provider-a",
    providerRequestId: "request-1",
    observedAt: new Date("2026-09-22T12:00:00.000Z"),
    expiresAt: new Date("2026-09-23T12:00:00.000Z"),
    comparables: [
      {
        externalListingId: "listing-1",
        listingName: "Comparable One",
        latitude: 18.21,
        longitude: -66.51,
        distanceKm: 1.2,
        similarityScore: 92,
        propertyType: "APARTMENT",
        bedrooms: 2,
        bathrooms: 1,
        maxGuests: 4,
        amenityCodes: ["POOL", "WIFI"],
        reviewScore: 4.8,
        reviewCount: 120,
        attributes: { source: "market" },
      },
    ],
    observations: [
      {
        stayDate: "2026-10-01",
        currency: "USD",
        sampleSize: 8,
        availableCount: 5,
        lowerRate: 150,
        medianRate: 190,
        upperRate: 240,
        providerSuggestedRate: 200,
      },
    ],
    metadata: { market: "san-juan" },
  };
}

function validate(result: unknown) {
  return validateMarketPricingProviderResult({
    expectedProvider: "provider-a",
    request,
    result,
  });
}

function issueCodes(result: unknown): MarketPricingProviderValidationIssueCode[] {
  const validation = validate(result);
  assert.equal(validation.valid, false);
  if (validation.valid) throw new Error("Expected provider response to be rejected.");
  return validation.issues.map((issue) => issue.code);
}

test("V1 accepts a complete and internally consistent provider response", () => {
  const result = validResult();
  assert.deepEqual(validate(result), { valid: true, value: result });
});

test("V1 rejects a response attributed to another provider", () => {
  const result = validResult();
  result.provider = "provider-b";
  assert.ok(issueCodes(result).includes("PROVIDER_MISMATCH"));
});

test("V1 rejects a snapshot that does not expire after observation", () => {
  const result = validResult();
  result.expiresAt = new Date(result.observedAt);
  assert.ok(issueCodes(result).includes("INVALID_EXPIRATION"));
});

test("V1 rejects a currency that differs from the property currency", () => {
  const result = validResult();
  result.observations[0].currency = "EUR";
  assert.ok(issueCodes(result).includes("CURRENCY_MISMATCH"));
});

test("V1 rejects duplicate daily observations", () => {
  const result = validResult();
  result.observations.push({ ...result.observations[0] });
  assert.ok(issueCodes(result).includes("DUPLICATE_OBSERVATION"));
});

test("V1 rejects observations outside the requested stay range", () => {
  const result = validResult();
  result.observations[0].stayDate = request.dateToExclusive;
  assert.ok(issueCodes(result).includes("OBSERVATION_OUT_OF_RANGE"));
});

test("V1 rejects availability counts larger than the sample", () => {
  const result = validResult();
  result.observations[0].availableCount = 9;
  assert.ok(issueCodes(result).includes("INVALID_OBSERVATION"));
});

test("V1 rejects an inverted lower, median and upper price distribution", () => {
  const result = validResult();
  result.observations[0].lowerRate = 220;
  result.observations[0].upperRate = 180;
  const codes = issueCodes(result);
  assert.equal(codes.filter((code) => code === "INVALID_OBSERVATION").length, 2);
});

test("V1 rejects duplicate comparable listing identities", () => {
  const result = validResult();
  result.comparables.push({ ...result.comparables[0] });
  assert.ok(issueCodes(result).includes("DUPLICATE_COMPARABLE"));
});

test("V1 rejects comparable coordinates outside geographic bounds", () => {
  const result = validResult();
  result.comparables[0].latitude = 91;
  assert.ok(issueCodes(result).includes("INVALID_COMPARABLE"));
});

test("V1 requires at least one daily observation", () => {
  const result = validResult();
  result.observations = [];
  assert.ok(issueCodes(result).includes("INVALID_COLLECTION"));
});

test("V1 rejects a non-object payload without throwing", () => {
  assert.deepEqual(validate(null), {
    valid: false,
    issues: [
      {
        code: "INVALID_COLLECTION",
        path: "result",
        message: "Provider result must be an object.",
      },
    ],
  });
});
