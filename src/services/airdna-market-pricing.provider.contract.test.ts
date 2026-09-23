import assert from "node:assert/strict";
import test from "node:test";

import {
  MarketPricingProviderError,
  type MarketPricingProviderRequest,
} from "./market-pricing-provider.contract";
import { validateMarketPricingProviderResult } from "./market-pricing-provider-validation.policy";
import {
  createAirDnaMarketPricingProvider,
  type AirDnaHttpTransport,
} from "./airdna-market-pricing.provider";

const request: MarketPricingProviderRequest = {
  property: {
    propertyId: "property-1",
    latitude: 18.1548,
    longitude: -65.8274,
    country: "Puerto Rico",
    region: "Puerto Rico",
    city: "Humacao",
    timezone: "America/Puerto_Rico",
    currency: "USD",
    propertyType: null,
    bedrooms: 2,
    bathrooms: 1,
    maxGuests: 4,
    amenityCodes: ["pool", "parking"],
  },
  dateFrom: "2026-10-01",
  dateToExclusive: "2026-10-04",
  marketRadiusKm: 8,
  maximumComparables: 3,
};

function transport(input: {
  compsStatus?: number;
  futureStatus?: number;
  retryAfter?: string;
} = {}) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const mock: AirDnaHttpTransport = {
    async post(call) {
      calls.push(call as any);
      if (call.url.endsWith("/listing/comps/area")) {
        return {
          status: input.compsStatus ?? 200,
          headers: input.retryAfter ? { "retry-after": input.retryAfter } : {},
          data: {
            payload: {
              listings: [
                {
                  property_id: "abnb_1",
                  market_id: "airdna-pr-1",
                  market_name: "Humacao",
                  title: "Pool Villa",
                  location: { lat: 18.155, lng: -65.828 },
                  distance: 240,
                  bedrooms: 2,
                  bathrooms: 1,
                  accommodates: 4,
                  property_type: "house",
                  listing_type: "entire_place",
                  amenities: { has_pool: true, has_parking: true, has_tv: false },
                  rating: 4.9,
                  reviews: 42,
                  average_daily_rate_ltm: 210.5,
                  occupancy_rate_ltm: 71.2,
                },
                {
                  property_id: "vrbo_2",
                  market_id: "airdna-pr-1",
                  market_name: "Humacao",
                  title: "Beach House",
                  location: { lat: 18.16, lng: -65.83 },
                  distance: 950,
                  bedrooms: 3,
                  bathrooms: 2,
                  accommodates: 6,
                  property_type: "house",
                  listing_type: "entire_place",
                  amenities: { has_pool: false, has_parking: true },
                  rating: 4.7,
                  reviews: 18,
                },
              ],
            },
            status: { response_id: "API-S-066" },
          },
        };
      }

      return {
        status: input.futureStatus ?? 200,
        headers: input.retryAfter ? { "retry-after": input.retryAfter } : {},
        data: {
          payload: {
            metrics: [
              {
                date: "2026-10-01",
                available_count: 20,
                booked_count: 30,
                median_available_rate: 180,
              },
              {
                date: "2026-10-02",
                available_count: 15,
                booked_count: 35,
                median_available_rate: 200,
              },
              {
                date: "2026-10-03",
                available_count: 10,
                booked_count: 40,
                median_available_rate: 220,
              },
              {
                date: "2026-10-04",
                available_count: 10,
                booked_count: 40,
                median_available_rate: 999,
              },
            ],
          },
          status: { response_id: "API-S-099" },
        },
      };
    },
  };
  return { mock, calls };
}

test("AirDNA adapter is disabled by default and performs no network work", async () => {
  const t = transport();
  const provider = createAirDnaMarketPricingProvider({ transport: t.mock });

  await assert.rejects(
    () => provider.fetchMarketPricing(request),
    (error: unknown) =>
      error instanceof MarketPricingProviderError &&
      error.code === "UNAVAILABLE" &&
      error.retryable === false,
  );
  assert.deepEqual(t.calls, []);
});

test("AirDNA adapter maps comps and future pricing into the neutral provider contract", async () => {
  const t = transport();
  const provider = createAirDnaMarketPricingProvider({
    enabled: true,
    apiKey: "test-key",
    transport: t.mock,
    clock: () => new Date("2026-09-23T12:00:00.000Z"),
  });

  const result = await provider.fetchMarketPricing(request);
  const validation = validateMarketPricingProviderResult({
    expectedProvider: "airdna",
    request,
    result,
  });

  assert.equal(validation.valid, true);
  assert.equal(result.provider, "airdna");
  assert.equal(result.providerRequestId, "API-S-099");
  assert.equal(result.comparables.length, 2);
  assert.equal(result.comparables[0].externalListingId, "abnb_1");
  assert.deepEqual(result.comparables[0].amenityCodes, ["parking", "pool"]);
  assert.equal(result.observations.length, 3);
  assert.deepEqual(result.observations[0], {
    stayDate: "2026-10-01",
    currency: "USD",
    sampleSize: 50,
    availableCount: 20,
    lowerRate: null,
    medianRate: 180,
    upperRate: null,
    providerSuggestedRate: null,
  });
  assert.equal(result.metadata?.marketId, "airdna-pr-1");

  assert.equal(t.calls.length, 2);
  assert.equal(
    t.calls[0].url,
    "https://api.airdna.co/api/enterprise/v2/listing/comps/area",
  );
  assert.equal(t.calls[0].headers.Authorization, "Bearer test-key");
  assert.deepEqual(t.calls[0].body, {
    lat: 18.1548,
    lng: -65.8274,
    radius: 8000,
    pagination: { page_size: 3, offset: 0 },
    currency: "usd",
    sort_order: "proximity",
    sort_direction: "ascending",
    filters: [
      { field: "bedrooms", type: "select", value: 2 },
      { field: "bathrooms", type: "select", value: 1 },
      { field: "accommodates", type: "select", value: 4 },
    ],
  });
  assert.equal(
    t.calls[1].url,
    "https://api.airdna.co/api/enterprise/v2/market/airdna-pr-1/future_pricing",
  );
  assert.equal(t.calls[1].body.num_months, 1);
  assert.equal(t.calls[1].body.currency, "usd");
});

test("AirDNA adapter never maps AirDNA future market medians as provider suggestions", async () => {
  const t = transport();
  const provider = createAirDnaMarketPricingProvider({
    enabled: true,
    apiKey: "test-key",
    transport: t.mock,
  });
  const result = await provider.fetchMarketPricing(request);
  assert.ok(result.observations.every((item) => item.providerSuggestedRate === null));
});

test("AirDNA adapter maps authentication, rate limit, unsupported market and unavailable errors", async () => {
  const scenarios = [
    { compsStatus: 401, code: "AUTHENTICATION_FAILED", retryable: false },
    { compsStatus: 404, code: "UNSUPPORTED_MARKET", retryable: false },
    { compsStatus: 429, retryAfter: "12", code: "RATE_LIMITED", retryable: true, retryAfterMs: 12000 },
    { futureStatus: 503, code: "UNAVAILABLE", retryable: true },
  ] as const;

  for (const scenario of scenarios) {
    const t = transport(scenario);
    const provider = createAirDnaMarketPricingProvider({
      enabled: true,
      apiKey: "test-key",
      transport: t.mock,
    });

    await assert.rejects(
      () => provider.fetchMarketPricing(request),
      (error: unknown) => {
        assert.ok(error instanceof MarketPricingProviderError);
        assert.equal(error.code, scenario.code);
        assert.equal(error.retryable, scenario.retryable);
        if ("retryAfterMs" in scenario) {
          assert.equal(error.retryAfterMs, scenario.retryAfterMs);
        }
        return true;
      },
    );
  }
});

test("AirDNA enabled provider requires credentials before any transport call", () => {
  const t = transport();
  assert.throws(
    () => createAirDnaMarketPricingProvider({ enabled: true, transport: t.mock }),
    (error: unknown) =>
      error instanceof MarketPricingProviderError &&
      error.code === "AUTHENTICATION_FAILED",
  );
  assert.deepEqual(t.calls, []);
});

test("AirDNA rejects unsafe origin overrides", () => {
  assert.throws(
    () =>
      createAirDnaMarketPricingProvider({
        apiOrigin: "https://example.com/api",
      }),
    (error: unknown) =>
      error instanceof MarketPricingProviderError &&
      error.code === "INVALID_REQUEST",
  );
});
