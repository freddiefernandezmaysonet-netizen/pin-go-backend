import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import { createMarketPricingRefreshRuntime } from "./market-pricing-refresh-runtime";

test("disabled runtime is a database-free no-op", async () => {
  const runtime = createMarketPricingRefreshRuntime({
    env: {
      PINGO_MARKET_PRICING_REFRESH_ENABLED: "false",
      PINGO_MARKET_PRICING_REFRESH_BATCH_SIZE: "not-a-number",
    },
    providers: [{ key: " invalid ", fetchMarketPricing: async () => assert.fail() }],
  });

  assert.equal(runtime.enabled, false);
  assert.deepEqual(runtime.config, { enabled: false });
  assert.deepEqual(await runtime.runOnce(), { status: "DISABLED" });
});

test("ambiguous activation values remain disabled", async () => {
  const runtime = createMarketPricingRefreshRuntime({
    env: { PINGO_MARKET_PRICING_REFRESH_ENABLED: "yes" },
  });

  assert.deepEqual(await runtime.runOnce(), { status: "DISABLED" });
});

test("enabled runtime requires an explicit Prisma client", () => {
  assert.throws(
    () =>
      createMarketPricingRefreshRuntime({
        env: { PINGO_MARKET_PRICING_REFRESH_ENABLED: "true" },
      }),
    /MARKET_PRICING_REFRESH_PRISMA_REQUIRED/,
  );
});

test("enabled runtime stays idle until runOnce is called", async () => {
  let queryCount = 0;
  let capturedQuery: unknown;
  const prisma = {
    marketPricingProfile: {
      async findMany(query: unknown) {
        queryCount += 1;
        capturedQuery = query;
        return [];
      },
    },
  } as unknown as PrismaClient;
  const runtime = createMarketPricingRefreshRuntime({
    env: { PINGO_MARKET_PRICING_REFRESH_ENABLED: "true" },
    prisma,
    clock: () => new Date("2026-09-22T12:00:00.000Z"),
  });

  assert.equal(runtime.enabled, true);
  assert.equal(queryCount, 0);

  const result = await runtime.runOnce();
  assert.equal(queryCount, 1);
  assert.deepEqual(result, {
    status: "EXECUTED",
    cycle: {
      selectedCount: 0,
      attemptedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      blockedCount: 0,
      skippedCount: 0,
      deferralFailureCount: 0,
      items: [],
    },
  });
  assert.equal((capturedQuery as { take: number }).take, 10);
});

test("runtime does not create a scheduler or interval", async () => {
  const originalSetInterval = globalThis.setInterval;
  let intervalCount = 0;
  globalThis.setInterval = ((..._args: unknown[]) => {
    intervalCount += 1;
    throw new Error("UNEXPECTED_INTERVAL");
  }) as typeof setInterval;

  try {
    const runtime = createMarketPricingRefreshRuntime();
    await runtime.runOnce();
    assert.equal(intervalCount, 0);
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});
