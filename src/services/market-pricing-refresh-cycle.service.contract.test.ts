import assert from "node:assert/strict";
import test from "node:test";

import {
  MarketPricingProviderError,
  type MarketPricingProvider,
  type MarketPricingProviderResult,
} from "./market-pricing-provider.contract";
import type {
  MarketPricingRefreshCandidate,
  MarketPricingRefreshCandidateRepository,
} from "./market-pricing-refresh-candidate.prisma-repository";
import {
  runMarketPricingRefreshCycle,
  type MarketPricingProviderRegistry,
  type MarketPricingRefreshCycleStateStore,
} from "./market-pricing-refresh-cycle.service";
import type { MarketPricingRefreshStore } from "./market-pricing-refresh.service";

const selectedAt = new Date("2026-09-22T20:00:00.000Z");
const settledAt = new Date("2026-09-22T20:00:01.000Z");
const retryBackoffMs = 15 * 60 * 1000;
const blockedBackoffMs = 24 * 60 * 60 * 1000;

async function errorMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("EXPECTED_OPERATION_TO_REJECT");
}

function readyCandidate(
  profileId = "profile-1",
  provider = "provider-a",
): Extract<MarketPricingRefreshCandidate, { status: "READY" }> {
  return {
    status: "READY",
    profileId,
    propertyId: `property-${profileId}`,
    provider,
    configuration: {
      profileId,
      strategy: "BALANCED",
      position: "COMPETITIVE",
      aggressiveness: "MODERATE",
    },
    request: {
      property: {
        propertyId: `property-${profileId}`,
        latitude: 18.21,
        longitude: -66.51,
        country: "PR",
        region: "Puerto Rico",
        city: "San Juan",
        timezone: "America/Puerto_Rico",
        currency: "USD",
        propertyType: null,
        bedrooms: null,
        bathrooms: null,
        maxGuests: 4,
        amenityCodes: ["WIFI"],
      },
      dateFrom: "2026-10-01",
      dateToExclusive: "2026-10-02",
      marketRadiusKm: 10,
      maximumComparables: 10,
    },
  };
}

function blockedCandidate(): Extract<
  MarketPricingRefreshCandidate,
  { status: "BLOCKED" }
> {
  return {
    status: "BLOCKED",
    profileId: "profile-blocked",
    propertyId: "property-blocked",
    provider: "provider-a",
    reason: "COORDINATES_REQUIRED",
  };
}

function validProviderResult(
  provider = "provider-a",
): MarketPricingProviderResult {
  return {
    provider,
    providerRequestId: "request-1",
    observedAt: selectedAt,
    expiresAt: new Date("2026-09-23T20:00:00.000Z"),
    comparables: [
      {
        externalListingId: "listing-1",
        listingName: null,
        latitude: 18.22,
        longitude: -66.52,
        distanceKm: 1.5,
        similarityScore: 90,
        propertyType: null,
        bedrooms: null,
        bathrooms: null,
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
    ],
    metadata: null,
  };
}

function providerFixture(
  input: {
    key?: string;
    error?: unknown;
    events?: string[];
  } = {},
): MarketPricingProvider {
  return {
    key: input.key ?? "provider-a",
    async fetchMarketPricing() {
      input.events?.push("provider");
      if (input.error) throw input.error;
      return validProviderResult(input.key ?? "provider-a");
    },
  };
}

function candidateRepositoryFixture(
  candidates: MarketPricingRefreshCandidate[],
  calls: unknown[] = [],
): MarketPricingRefreshCandidateRepository {
  return {
    async listDue(input) {
      calls.push(input);
      return candidates;
    },
  };
}

type DeferInput = Parameters<
  MarketPricingRefreshCycleStateStore["deferProfile"]
>[0];

function stateStoreFixture(
  input: {
    result?: boolean;
    error?: Error;
  } = {},
) {
  const deferrals: DeferInput[] = [];
  const stateStore: MarketPricingRefreshCycleStateStore = {
    async deferProfile(value) {
      deferrals.push(value);
      if (input.error) throw input.error;
      return input.result ?? true;
    },
  };
  return { stateStore, deferrals };
}

function refreshStoreFixture(
  input: {
    createError?: Error;
    events?: string[];
  } = {},
) {
  const failures: unknown[] = [];
  const refreshStore: MarketPricingRefreshStore = {
    async createRun() {
      input.events?.push("create-run");
      if (input.createError) throw input.createError;
      return { runId: "run-1" };
    },
    async completeRunAtomically(value) {
      input.events?.push("complete-run");
      return {
        snapshotCount: value.snapshots.length,
        changedDateKeys: value.snapshots.map((snapshot) => snapshot.stayDate),
      };
    },
    async failRun(value) {
      input.events?.push("fail-run");
      failures.push(value);
    },
  };
  return { refreshStore, failures };
}

function registryFixture(
  providers: Record<string, MarketPricingProvider | null>,
  events?: string[],
): MarketPricingProviderRegistry {
  return {
    resolve(provider) {
      events?.push(`resolve:${provider}`);
      return providers[provider] ?? null;
    },
  };
}

function execute(input: {
  candidates: MarketPricingRefreshCandidate[];
  refreshStore?: MarketPricingRefreshStore;
  stateStore?: MarketPricingRefreshCycleStateStore;
  registry?: MarketPricingProviderRegistry;
  repositoryCalls?: unknown[];
}) {
  return runMarketPricingRefreshCycle({
    candidateRepository: candidateRepositoryFixture(
      input.candidates,
      input.repositoryCalls,
    ),
    refreshStore: input.refreshStore ?? refreshStoreFixture().refreshStore,
    stateStore: input.stateStore ?? stateStoreFixture().stateStore,
    providerRegistry:
      input.registry ?? registryFixture({ "provider-a": providerFixture() }),
    now: selectedAt,
    clock: () => settledAt,
    batchSize: 20,
    horizonDays: 365,
    currency: "USD",
    retryBackoffMs,
    blockedBackoffMs,
  });
}

test("the cycle defers blocked data and completes a ready refresh sequentially", async () => {
  const events: string[] = [];
  const repositoryCalls: unknown[] = [];
  const state = stateStoreFixture();
  const refresh = refreshStoreFixture({ events });
  const provider = providerFixture({ events });

  const result = await execute({
    candidates: [blockedCandidate(), readyCandidate()],
    refreshStore: refresh.refreshStore,
    stateStore: state.stateStore,
    registry: registryFixture({ "provider-a": provider }, events),
    repositoryCalls,
  });

  assert.deepEqual(result, {
    selectedCount: 2,
    attemptedCount: 1,
    succeededCount: 1,
    failedCount: 0,
    blockedCount: 1,
    skippedCount: 0,
    deferralFailureCount: 0,
    items: [
      {
        profileId: "profile-blocked",
        propertyId: "property-blocked",
        provider: "provider-a",
        status: "BLOCKED",
        errorCode: "COORDINATES_REQUIRED",
        deferred: true,
      },
      {
        profileId: "profile-1",
        propertyId: "property-profile-1",
        provider: "provider-a",
        status: "SUCCEEDED",
        errorCode: null,
        deferred: false,
      },
    ],
  });
  assert.deepEqual(events, [
    "resolve:provider-a",
    "create-run",
    "provider",
    "complete-run",
  ]);
  assert.deepEqual(repositoryCalls, [
    {
      now: selectedAt,
      limit: 20,
      horizonDays: 365,
      currency: "USD",
    },
  ]);
  assert.deepEqual(state.deferrals, [
    {
      profileId: "profile-blocked",
      selectedAt,
      nextAttemptAt: new Date("2026-09-23T20:00:01.000Z"),
      errorCode: "COORDINATES_REQUIRED",
    },
  ]);
});

test("an unavailable or mismatched provider is never invoked and uses blocked backoff", async () => {
  const state = stateStoreFixture();
  const wrongProvider = providerFixture({ key: "another-provider" });
  const result = await execute({
    candidates: [
      readyCandidate("missing", "missing-provider"),
      readyCandidate("mismatch", "provider-a"),
    ],
    stateStore: state.stateStore,
    registry: registryFixture({
      "missing-provider": null,
      "provider-a": wrongProvider,
    }),
  });

  assert.equal(result.attemptedCount, 0);
  assert.equal(result.failedCount, 2);
  assert.deepEqual(
    result.items.map((item) => item.errorCode),
    [
      "MARKET_PRICING_PROVIDER_UNAVAILABLE",
      "MARKET_PRICING_PROVIDER_KEY_MISMATCH",
    ],
  );
  assert.equal(state.deferrals.length, 2);
  assert.equal(
    state.deferrals[0]?.nextAttemptAt.toISOString(),
    "2026-09-23T20:00:01.000Z",
  );
});

test("a safe provider failure is recorded and deferred with retry backoff", async () => {
  const state = stateStoreFixture();
  const refresh = refreshStoreFixture();
  const provider = providerFixture({
    error: new MarketPricingProviderError({
      code: "UNAVAILABLE",
      provider: "provider-a",
      message: "Provider unavailable",
      retryable: true,
    }),
  });

  const result = await execute({
    candidates: [readyCandidate()],
    refreshStore: refresh.refreshStore,
    stateStore: state.stateStore,
    registry: registryFixture({ "provider-a": provider }),
  });

  assert.equal(result.items[0]?.status, "REFRESH_FAILED");
  assert.equal(result.items[0]?.errorCode, "UNAVAILABLE");
  assert.equal(refresh.failures.length, 1);
  assert.equal(
    state.deferrals[0]?.nextAttemptAt.toISOString(),
    "2026-09-22T20:15:01.000Z",
  );
});

test("a concurrent active refresh is skipped without provider call or backoff", async () => {
  const events: string[] = [];
  const state = stateStoreFixture();
  const refresh = refreshStoreFixture({
    events,
    createError: new Error("MARKET_PRICING_REFRESH_ALREADY_RUNNING"),
  });
  const provider = providerFixture({ events });

  const result = await execute({
    candidates: [readyCandidate()],
    refreshStore: refresh.refreshStore,
    stateStore: state.stateStore,
    registry: registryFixture({ "provider-a": provider }, events),
  });

  assert.equal(result.items[0]?.status, "ALREADY_RUNNING");
  assert.equal(result.skippedCount, 1);
  assert.equal(result.attemptedCount, 0);
  assert.deepEqual(events, ["resolve:provider-a", "create-run"]);
  assert.equal(state.deferrals.length, 0);
});

test("an unexpected execution failure is isolated and deferred", async () => {
  const state = stateStoreFixture();
  const refresh = refreshStoreFixture({
    createError: new Error("DATABASE_UNAVAILABLE"),
  });

  const result = await execute({
    candidates: [readyCandidate()],
    refreshStore: refresh.refreshStore,
    stateStore: state.stateStore,
  });

  assert.equal(result.items[0]?.status, "EXECUTION_FAILED");
  assert.equal(
    result.items[0]?.errorCode,
    "MARKET_PRICING_REFRESH_EXECUTION_FAILED",
  );
  assert.equal(result.failedCount, 1);
  assert.equal(state.deferrals.length, 1);
});

test("a deferral store failure is reported without aborting the batch", async () => {
  const state = stateStoreFixture({ error: new Error("DATABASE_UNAVAILABLE") });

  const result = await execute({
    candidates: [blockedCandidate(), readyCandidate()],
    stateStore: state.stateStore,
  });

  assert.equal(result.deferralFailureCount, 1);
  assert.equal(result.items[0]?.deferred, false);
  assert.equal(result.items[1]?.status, "SUCCEEDED");
});

test("an empty due batch performs no provider or persistence work", async () => {
  const result = await execute({ candidates: [] });

  assert.deepEqual(result, {
    selectedCount: 0,
    attemptedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    blockedCount: 0,
    skippedCount: 0,
    deferralFailureCount: 0,
    items: [],
  });
});

test("invalid cycle limits fail before candidate selection", async () => {
  const repositoryCalls: unknown[] = [];
  const base = {
    candidateRepository: candidateRepositoryFixture([], repositoryCalls),
    refreshStore: refreshStoreFixture().refreshStore,
    stateStore: stateStoreFixture().stateStore,
    providerRegistry: registryFixture({}),
    now: selectedAt,
    clock: () => settledAt,
    batchSize: 20,
    horizonDays: 365,
    currency: "USD",
    retryBackoffMs,
    blockedBackoffMs,
  };

  assert.equal(
    await errorMessage(
      runMarketPricingRefreshCycle({ ...base, batchSize: 101 }),
    ),
    "MARKET_PRICING_CYCLE_BATCH_SIZE_INVALID",
  );
  assert.equal(
    await errorMessage(
      runMarketPricingRefreshCycle({ ...base, horizonDays: 731 }),
    ),
    "MARKET_PRICING_CYCLE_HORIZON_INVALID",
  );
  assert.equal(
    await errorMessage(
      runMarketPricingRefreshCycle({ ...base, retryBackoffMs: 0 }),
    ),
    "MARKET_PRICING_CYCLE_RETRY_BACKOFF_INVALID",
  );
  assert.equal(
    await errorMessage(
      runMarketPricingRefreshCycle({ ...base, now: new Date("invalid") }),
    ),
    "MARKET_PRICING_CYCLE_NOW_INVALID",
  );
  assert.equal(repositoryCalls.length, 0);
});
