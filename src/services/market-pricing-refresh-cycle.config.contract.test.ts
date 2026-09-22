import assert from "node:assert/strict";
import test from "node:test";

import { resolveMarketPricingRefreshCycleConfig } from "./market-pricing-refresh-cycle.config";

function errorMessage(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("EXPECTED_OPERATION_TO_REJECT");
}

test("cycle configuration is non-executable by default", () => {
  assert.deepEqual(resolveMarketPricingRefreshCycleConfig(), {
    enabled: false,
  });
});

test("disabled configuration ignores dormant tuning values", () => {
  assert.deepEqual(
    resolveMarketPricingRefreshCycleConfig({
      PINGO_MARKET_PRICING_REFRESH_BATCH_SIZE: "not-a-number",
      PINGO_MARKET_PRICING_REFRESH_HORIZON_DAYS: "9999",
      PINGO_MARKET_PRICING_REFRESH_RETRY_BACKOFF_MS: "0",
      PINGO_MARKET_PRICING_REFRESH_BLOCKED_BACKOFF_MS: "0",
    }),
    { enabled: false },
  );
});

test("explicit activation produces conservative bounded defaults", () => {
  assert.deepEqual(
    resolveMarketPricingRefreshCycleConfig({
      PINGO_MARKET_PRICING_REFRESH_ENABLED: "true",
    }),
    {
      enabled: true,
      batchSize: 10,
      horizonDays: 365,
      retryBackoffMs: 15 * 60 * 1000,
      blockedBackoffMs: 24 * 60 * 60 * 1000,
    },
  );
});

test("explicit activation accepts safe custom cycle limits", () => {
  assert.deepEqual(
    resolveMarketPricingRefreshCycleConfig({
      PINGO_MARKET_PRICING_REFRESH_ENABLED: "true",
      PINGO_MARKET_PRICING_REFRESH_BATCH_SIZE: "25",
      PINGO_MARKET_PRICING_REFRESH_HORIZON_DAYS: "180",
      PINGO_MARKET_PRICING_REFRESH_RETRY_BACKOFF_MS: "3600000",
      PINGO_MARKET_PRICING_REFRESH_BLOCKED_BACKOFF_MS: "7200000",
    }),
    {
      enabled: true,
      batchSize: 25,
      horizonDays: 180,
      retryBackoffMs: 3_600_000,
      blockedBackoffMs: 7_200_000,
    },
  );
});

test("enabled configuration rejects unsafe batch and horizon values", () => {
  const enabled = { PINGO_MARKET_PRICING_REFRESH_ENABLED: "true" };

  assert.equal(
    errorMessage(() =>
      resolveMarketPricingRefreshCycleConfig({
        ...enabled,
        PINGO_MARKET_PRICING_REFRESH_BATCH_SIZE: "101",
      }),
    ),
    "PINGO_MARKET_PRICING_REFRESH_BATCH_SIZE_INVALID",
  );
  assert.equal(
    errorMessage(() =>
      resolveMarketPricingRefreshCycleConfig({
        ...enabled,
        PINGO_MARKET_PRICING_REFRESH_HORIZON_DAYS: "0",
      }),
    ),
    "PINGO_MARKET_PRICING_REFRESH_HORIZON_DAYS_INVALID",
  );
});

test("enabled configuration rejects unsafe or inverted backoffs", () => {
  const enabled = { PINGO_MARKET_PRICING_REFRESH_ENABLED: "true" };

  assert.equal(
    errorMessage(() =>
      resolveMarketPricingRefreshCycleConfig({
        ...enabled,
        PINGO_MARKET_PRICING_REFRESH_RETRY_BACKOFF_MS: "59999",
      }),
    ),
    "PINGO_MARKET_PRICING_REFRESH_RETRY_BACKOFF_MS_INVALID",
  );
  assert.equal(
    errorMessage(() =>
      resolveMarketPricingRefreshCycleConfig({
        ...enabled,
        PINGO_MARKET_PRICING_REFRESH_RETRY_BACKOFF_MS: "3600000",
        PINGO_MARKET_PRICING_REFRESH_BLOCKED_BACKOFF_MS: "1800000",
      }),
    ),
    "PINGO_MARKET_PRICING_REFRESH_BACKOFF_ORDER_INVALID",
  );
});
