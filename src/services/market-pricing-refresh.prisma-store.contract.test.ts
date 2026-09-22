import { Prisma, type PrismaClient } from "@prisma/client";
import assert from "node:assert/strict";
import test from "node:test";

import { createPrismaMarketPricingRefreshStore } from "./market-pricing-refresh.prisma-store";
import type { MarketComparableCandidate } from "./market-pricing-provider.contract";
import type { DerivedMarketPricingSnapshot } from "./market-pricing-refresh.service";

const completedAt = new Date("2026-09-22T18:00:00.000Z");
const observedAt = new Date("2026-09-22T17:00:00.000Z");
const expiresAt = new Date("2026-09-23T17:00:00.000Z");

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value as UnknownRecord;
}

async function errorMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("EXPECTED_OPERATION_TO_REJECT");
}

function snapshot(
  stayDate: string,
  targetRate: number,
  confidence: number,
): DerivedMarketPricingSnapshot {
  return {
    stayDate,
    currency: "USD",
    sampleSize: 8,
    availableCount: 4,
    lowerRate: 160,
    medianRate: 200,
    upperRate: 240,
    targetRate,
    confidence,
    observedAt,
    expiresAt,
    evidence: {
      referenceRate: 200,
      availabilityRatio: 0.5,
      marketTightness: 0.5,
      positionFactor: 1,
      demandAdjustmentPercent: 0,
      sampleConfidence: 32,
      similarityConfidence: 36,
      stabilityConfidence: 18,
      averageSimilarityScore: 90,
      priceSpreadRatio: 0.4,
      comparableCount: 1,
      providerSuggestedRate: null,
    },
  };
}

const comparable: MarketComparableCandidate = {
  externalListingId: "listing-1",
  listingName: "Comparable 1",
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
  attributes: { source: "provider" },
};

type PreviousSnapshot = {
  stayDate: Date;
  targetRate: Prisma.Decimal;
  confidence: Prisma.Decimal;
};

function prismaFixture(
  options: {
    runStatus?: "RUNNING" | "SUCCEEDED";
    runProfileId?: string;
    previousRows?: PreviousSnapshot[];
    createdCount?: number;
    completionCount?: number;
    failureCount?: number;
  } = {},
) {
  const events: string[] = [];
  const calls = {
    runCreates: [] as unknown[],
    runUpdates: [] as unknown[],
    profileUpdates: [] as unknown[],
    profileUpdateMany: [] as unknown[],
    comparableUpdates: [] as unknown[],
    comparableUpserts: [] as unknown[],
    snapshotFinds: [] as unknown[],
    snapshotCreates: [] as unknown[],
  };

  const tx = {
    async $executeRaw(): Promise<number> {
      events.push("lock");
      return 1;
    },
    marketPricingRun: {
      async findUnique(): Promise<UnknownRecord> {
        events.push("read-run");
        return {
          id: "run-1",
          profileId: options.runProfileId ?? "profile-1",
          provider: "provider-a",
          status: options.runStatus ?? "RUNNING",
        };
      },
      async updateMany(args: unknown): Promise<{ count: number }> {
        events.push("update-run");
        calls.runUpdates.push(args);
        return { count: options.completionCount ?? options.failureCount ?? 1 };
      },
    },
    marketPricingProfile: {
      async findUnique(): Promise<UnknownRecord> {
        events.push("read-profile");
        return {
          minimumConfidence: new Prisma.Decimal(70),
          refreshIntervalHours: 24,
        };
      },
      async update(args: unknown): Promise<UnknownRecord> {
        events.push("update-profile");
        calls.profileUpdates.push(args);
        return {};
      },
      async updateMany(args: unknown): Promise<{ count: number }> {
        events.push("update-profile-many");
        calls.profileUpdateMany.push(args);
        return { count: 1 };
      },
    },
    marketComparable: {
      async updateMany(args: unknown): Promise<{ count: number }> {
        events.push("stale-comparables");
        calls.comparableUpdates.push(args);
        return { count: 1 };
      },
      async upsert(args: unknown): Promise<UnknownRecord> {
        events.push("upsert-comparable");
        calls.comparableUpserts.push(args);
        return {};
      },
    },
    marketPricingSnapshot: {
      async findMany(args: unknown): Promise<PreviousSnapshot[]> {
        events.push("read-snapshots");
        calls.snapshotFinds.push(args);
        return options.previousRows ?? [];
      },
      async createMany(args: unknown): Promise<{ count: number }> {
        events.push("create-snapshots");
        calls.snapshotCreates.push(args);
        return { count: options.createdCount ?? 3 };
      },
    },
  };

  const prisma = {
    marketPricingRun: {
      async create(args: unknown): Promise<{ id: string }> {
        calls.runCreates.push(args);
        return { id: "run-1" };
      },
      async findUnique(): Promise<{ profileId: string }> {
        return { profileId: "profile-1" };
      },
    },
    async $transaction<T>(operation: (client: typeof tx) => Promise<T>) {
      events.push("transaction");
      return operation(tx);
    },
  } as unknown as PrismaClient;

  return {
    store: createPrismaMarketPricingRefreshStore(prisma),
    calls,
    events,
  };
}

test("createRun persists UTC dates with an exclusive upper bound", async () => {
  const fixture = prismaFixture();

  const result = await fixture.store.createRun({
    profileId: "profile-1",
    provider: "provider-a",
    requestedDateFrom: "2026-10-01",
    requestedDateToExclusive: "2026-10-04",
    startedAt: observedAt,
  });

  assert.deepEqual(result, { runId: "run-1" });
  const data = record(record(fixture.calls.runCreates[0]).data);
  assert.equal(
    (data.requestedDateFrom as Date).toISOString(),
    "2026-10-01T00:00:00.000Z",
  );
  assert.equal(
    (data.requestedDateTo as Date).toISOString(),
    "2026-10-04T00:00:00.000Z",
  );
  assert.deepEqual(data.metadata, { rangeSemantics: "DATE_TO_EXCLUSIVE" });
});

test("atomic completion locks first, stales absent comparables, and detects exact changed dates", async () => {
  const fixture = prismaFixture({
    previousRows: [
      {
        stayDate: new Date("2026-10-01T00:00:00.000Z"),
        targetRate: new Prisma.Decimal(200),
        confidence: new Prisma.Decimal(80),
      },
      {
        stayDate: new Date("2026-10-02T00:00:00.000Z"),
        targetRate: new Prisma.Decimal(212),
        confidence: new Prisma.Decimal(60),
      },
    ],
  });

  const result = await fixture.store.completeRunAtomically({
    runId: "run-1",
    profileId: "profile-1",
    provider: "provider-a",
    providerRequestId: "request-1",
    comparables: [comparable],
    snapshots: [
      snapshot("2026-10-01", 200, 80),
      snapshot("2026-10-02", 212, 75),
      snapshot("2026-10-03", 220, 85),
    ],
    completedAt,
  });

  assert.deepEqual(result, {
    snapshotCount: 3,
    changedDateKeys: ["2026-10-02", "2026-10-03"],
  });
  assert.deepEqual(fixture.events.slice(0, 3), [
    "transaction",
    "lock",
    "read-run",
  ]);

  const staleWhere = record(record(fixture.calls.comparableUpdates[0]).where);
  assert.deepEqual(staleWhere.externalListingId, { notIn: ["listing-1"] });
  assert.equal(fixture.calls.comparableUpserts.length, 1);

  const snapshotCreate = record(fixture.calls.snapshotCreates[0]);
  assert.equal(snapshotCreate.skipDuplicates, true);
  const rows = snapshotCreate.data as UnknownRecord[];
  assert.equal(record(rows[0].evidence).currency, "USD");

  const runData = record(record(fixture.calls.runUpdates[0]).data);
  assert.deepEqual(runData.changedDateKeys, ["2026-10-02", "2026-10-03"]);
  assert.equal(runData.status, "SUCCEEDED");

  const profileData = record(record(fixture.calls.profileUpdates[0]).data);
  assert.equal(
    (profileData.nextRefreshAt as Date).toISOString(),
    "2026-09-23T18:00:00.000Z",
  );
});

test("a price delta of one cent is a changed date without a confidence crossing", async () => {
  const fixture = prismaFixture({
    previousRows: [
      {
        stayDate: new Date("2026-10-01T00:00:00.000Z"),
        targetRate: new Prisma.Decimal("199.99"),
        confidence: new Prisma.Decimal(80),
      },
    ],
    createdCount: 1,
  });

  const result = await fixture.store.completeRunAtomically({
    runId: "run-1",
    profileId: "profile-1",
    provider: "provider-a",
    providerRequestId: null,
    comparables: [comparable],
    snapshots: [snapshot("2026-10-01", 200, 80)],
    completedAt,
  });

  assert.deepEqual(result.changedDateKeys, ["2026-10-01"]);
});

test("an idempotent replay inserts nothing and republishes no dates", async () => {
  const fixture = prismaFixture({
    previousRows: [
      {
        stayDate: new Date("2026-10-01T00:00:00.000Z"),
        targetRate: new Prisma.Decimal(200),
        confidence: new Prisma.Decimal(80),
      },
    ],
    createdCount: 0,
  });

  const result = await fixture.store.completeRunAtomically({
    runId: "run-1",
    profileId: "profile-1",
    provider: "provider-a",
    providerRequestId: "same-request",
    comparables: [comparable],
    snapshots: [snapshot("2026-10-01", 200, 80)],
    completedAt,
  });

  assert.deepEqual(result, { snapshotCount: 0, changedDateKeys: [] });
});

test("an empty provider set marks every active comparable stale", async () => {
  const fixture = prismaFixture({ createdCount: 1 });

  await fixture.store.completeRunAtomically({
    runId: "run-1",
    profileId: "profile-1",
    provider: "provider-a",
    providerRequestId: null,
    comparables: [],
    snapshots: [snapshot("2026-10-01", 200, 80)],
    completedAt,
  });

  const where = record(record(fixture.calls.comparableUpdates[0]).where);
  assert.equal("externalListingId" in where, false);
  assert.equal(fixture.calls.comparableUpserts.length, 0);
});

test("a terminal or mismatched run aborts before snapshot writes", async () => {
  for (const options of [
    { runStatus: "SUCCEEDED" as const },
    { runProfileId: "another-profile" },
  ]) {
    const fixture = prismaFixture(options);
    const message = await errorMessage(
      fixture.store.completeRunAtomically({
        runId: "run-1",
        profileId: "profile-1",
        provider: "provider-a",
        providerRequestId: null,
        comparables: [comparable],
        snapshots: [snapshot("2026-10-01", 200, 80)],
        completedAt,
      }),
    );

    assert.equal(message, "MARKET_PRICING_RUN_NOT_COMPLETABLE");
    assert.equal(fixture.calls.snapshotCreates.length, 0);
    assert.equal(fixture.calls.runUpdates.length, 0);
  }
});

test("failRun records one failure and never overwrites a terminal run", async () => {
  const failing = prismaFixture();
  await failing.store.failRun({
    runId: "run-1",
    errorCode: "UNAVAILABLE",
    errorSummary: "Provider unavailable",
    completedAt,
  });

  const failedData = record(record(failing.calls.runUpdates[0]).data);
  assert.equal(failedData.status, "FAILED");
  assert.equal(failing.calls.profileUpdateMany.length, 1);

  const terminal = prismaFixture({ failureCount: 0 });
  await terminal.store.failRun({
    runId: "run-1",
    errorCode: "UNAVAILABLE",
    errorSummary: "Provider unavailable",
    completedAt,
  });
  assert.equal(terminal.calls.profileUpdateMany.length, 0);
});
