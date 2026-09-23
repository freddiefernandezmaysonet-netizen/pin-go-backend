import assert from "node:assert/strict";
import test from "node:test";

import {
  MarketPricingProviderError,
  type MarketPricingProvider,
  type MarketPricingProviderRequest,
  type MarketPricingProviderResult,
} from "./market-pricing-provider.contract";
import {
  refreshMarketPricing,
  type MarketPricingRefreshStore,
} from "./market-pricing-refresh.service";

const now = new Date("2026-09-22T12:00:00.000Z");
const completedAt = new Date("2026-09-22T12:00:01.000Z");

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
    amenityCodes: ["WIFI"],
  },
  dateFrom: "2026-10-01",
  dateToExclusive: "2026-10-03",
  marketRadiusKm: 10,
  maximumComparables: 10,
};

function validProviderResult(): MarketPricingProviderResult {
  return {
    provider: "provider-a",
    providerRequestId: "provider-request-1",
    observedAt: now,
    expiresAt: new Date("2026-09-23T12:00:00.000Z"),
    comparables: [
      {
        externalListingId: "listing-1",
        listingName: null,
        latitude: 18.21,
        longitude: -66.51,
        distanceKm: 1.2,
        similarityScore: 90,
        propertyType: "APARTMENT",
        bedrooms: 2,
        bathrooms: 1,
        maxGuests: 4,
        amenityCodes: ["WIFI"],
        reviewScore: 4.8,
        reviewCount: 100,
        attributes: null,
      },
    ],
    observations: [
      {
        stayDate: "2026-10-01",
        currency: "USD",
        sampleSize: 8,
        availableCount: 4,
        lowerRate: 160,
        medianRate: 200,
        upperRate: 240,
        providerSuggestedRate: 999,
      },
      {
        stayDate: "2026-10-02",
        currency: "USD",
        sampleSize: 8,
        availableCount: 0,
        lowerRate: 160,
        medianRate: 200,
        upperRate: 240,
        providerSuggestedRate: 1,
      },
    ],
    metadata: null,
  };
}

type CreateRunInput = Parameters<MarketPricingRefreshStore["createRun"]>[0];
type CompleteRunInput = Parameters<
  MarketPricingRefreshStore["completeRunAtomically"]
>[0];
type FailRunInput = Parameters<MarketPricingRefreshStore["failRun"]>[0];

function storeFixture(input: {
  events?: string[];
  completeError?: Error;
  failError?: Error;
} = {}) {
  const creates: CreateRunInput[] = [];
  const completes: CompleteRunInput[] = [];
  const failures: FailRunInput[] = [];
  const events = input.events ?? [];

  const store: MarketPricingRefreshStore = {
    async createRun(value) {
      events.push("create-run");
      creates.push(value);
      return { runId: "run-1" };
    },
    async completeRunAtomically(value) {
      events.push("complete-atomically");
      completes.push(value);
      if (input.completeError) throw input.completeError;
      return {
        snapshotCount: value.snapshots.length,
        changedDateKeys: ["2026-10-02", "2026-10-01"],
      };
    },
    async failRun(value) {
      events.push("fail-run");
      failures.push(value);
      if (input.failError) throw input.failError;
    },
  };

  return { store, creates, completes, failures, events };
}

function providerFixture(input: {
  result?: MarketPricingProviderResult;
  error?: unknown;
  events?: string[];
  key?: string;
} = {}): MarketPricingProvider {
  return {
    key: input.key ?? "provider-a",
    async fetchMarketPricing() {
      input.events?.push("fetch-provider");
      if (input.error) throw input.error;
      return input.result ?? validProviderResult();
    },
  };
}

function execute(input: {
  provider?: MarketPricingProvider;
  store: MarketPricingRefreshStore;
}) {
  return refreshMarketPricing({
    provider: input.provider ?? providerFixture(),
    store: input.store,
    request,
    configuration: {
      profileId: "profile-1",
      strategy: "BALANCED",
      position: "COMPETITIVE",
      aggressiveness: "MODERATE",
    },
    now,
    clock: () => completedAt,
  });
}

test("V1 fetches, validates, derives and persists one atomic batch", async () => {
  const events: string[] = [];
  const fixture = storeFixture({ events });
  const result = await execute({
    provider: providerFixture({ events }),
    store: fixture.store,
  });

  assert.deepEqual(events, ["create-run", "fetch-provider", "complete-atomically"]);
  assert.deepEqual(result, {
    status: "SUCCEEDED",
    runId: "run-1",
    snapshotCount: 2,
    changedDateKeys: ["2026-10-01", "2026-10-02"],
  });
  assert.equal(fixture.completes.length, 1);
  assert.equal(fixture.failures.length, 0);
  assert.deepEqual(
    fixture.completes[0].snapshots.map((snapshot) => snapshot.targetRate),
    [200, 212]
  );
});

test("V1 preserves provider suggestions only as evidence", async () => {
  const fixture = storeFixture();
  await execute({ store: fixture.store });
  assert.deepEqual(
    fixture.completes[0].snapshots.map(
      (snapshot) => snapshot.evidence.providerSuggestedRate
    ),
    [999, 1]
  );
  assert.deepEqual(
    fixture.completes[0].snapshots.map((snapshot) => snapshot.targetRate),
    [200, 212]
  );
});

test("V1 rejects the full batch when one provider observation is invalid", async () => {
  const providerResult = validProviderResult();
  providerResult.observations[1].currency = "EUR";
  const fixture = storeFixture();
  const result = await execute({
    provider: providerFixture({ result: providerResult }),
    store: fixture.store,
  });

  assert.deepEqual(result, {
    status: "FAILED",
    runId: "run-1",
    errorCode: "INVALID_RESPONSE",
  });
  assert.equal(fixture.completes.length, 0);
  assert.equal(fixture.failures[0].errorCode, "INVALID_RESPONSE");
  assert.ok(fixture.failures[0].errorSummary.includes("CURRENCY_MISMATCH"));
  assert.ok(!fixture.failures[0].errorSummary.includes("EUR"));
});

test("V1 records a safe provider error without attempting persistence", async () => {
  const fixture = storeFixture();
  const result = await execute({
    provider: providerFixture({
      error: new MarketPricingProviderError({
        code: "UNAVAILABLE",
        provider: "provider-a",
        message: "Provider is temporarily unavailable.",
        retryable: true,
      }),
    }),
    store: fixture.store,
  });

  assert.equal(result.status, "FAILED");
  assert.deepEqual(fixture.failures[0], {
    runId: "run-1",
    errorCode: "UNAVAILABLE",
    errorSummary: "Provider is temporarily unavailable.",
    completedAt,
  });
  assert.equal(fixture.completes.length, 0);
});

test("V1 does not leak unexpected provider exception details", async () => {
  const fixture = storeFixture();
  await execute({
    provider: providerFixture({ error: new Error("secret raw payload") }),
    store: fixture.store,
  });
  assert.equal(fixture.failures[0].errorCode, "UNEXPECTED_PROVIDER_ERROR");
  assert.ok(!fixture.failures[0].errorSummary.includes("secret raw payload"));
});

test("V1 marks the run failed when atomic persistence fails", async () => {
  const fixture = storeFixture({ completeError: new Error("database details") });
  const result = await execute({ store: fixture.store });
  assert.deepEqual(result, {
    status: "FAILED",
    runId: "run-1",
    errorCode: "PERSISTENCE_FAILED",
  });
  assert.equal(fixture.completes.length, 1);
  assert.equal(fixture.failures[0].errorCode, "PERSISTENCE_FAILED");
  assert.ok(!fixture.failures[0].errorSummary.includes("database details"));
});

test("V1 preserves the original outcome when failure recording also fails", async () => {
  const fixture = storeFixture({ failError: new Error("audit unavailable") });
  const result = await execute({
    provider: providerFixture({
      error: new MarketPricingProviderError({
        code: "RATE_LIMITED",
        provider: "provider-a",
        message: "Rate limited.",
        retryable: true,
      }),
    }),
    store: fixture.store,
  });
  assert.deepEqual(result, {
    status: "FAILED",
    runId: "run-1",
    errorCode: "RATE_LIMITED",
  });
});

test("V1 rejects a missing provider key before creating a run", async () => {
  const fixture = storeFixture();
  let error: unknown;
  try {
    await execute({
      provider: providerFixture({ key: " " }),
      store: fixture.store,
    });
  } catch (caught) {
    error = caught;
  }
  assert.equal(
    error instanceof Error ? error.message : null,
    "MARKET_PRICING_PROVIDER_KEY_REQUIRED"
  );
  assert.equal(fixture.creates.length, 0);
});
