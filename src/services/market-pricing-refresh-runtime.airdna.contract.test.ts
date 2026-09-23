import assert from "node:assert/strict";
import test from "node:test";

import { MarketPricingProviderError } from "./market-pricing-provider.contract";
import {
  builtInMarketPricingProviders,
  createMarketPricingRefreshRuntime,
} from "./market-pricing-refresh-runtime";

test("AirDNA is not registered when its provider activation flag is absent", () => {
  assert.deepEqual(builtInMarketPricingProviders(), []);
  assert.deepEqual(
    builtInMarketPricingProviders({
      env: { PINGO_MARKET_PRICING_AIRDNA_API_KEY: "unused-key" },
    }),
    [],
  );
});

test("AirDNA provider activation only accepts explicit true", () => {
  for (const value of ["1", "yes", "enabled", "on", "false", ""]) {
    assert.deepEqual(
      builtInMarketPricingProviders({
        env: {
          PINGO_MARKET_PRICING_AIRDNA_ENABLED: value,
          PINGO_MARKET_PRICING_AIRDNA_API_KEY: "unused-key",
        },
      }),
      [],
    );
  }
});

test("explicit AirDNA activation without credentials fails closed", () => {
  assert.throws(
    () =>
      builtInMarketPricingProviders({
        env: { PINGO_MARKET_PRICING_AIRDNA_ENABLED: "true" },
      }),
    (error: unknown) =>
      error instanceof MarketPricingProviderError &&
      error.code === "AUTHENTICATION_FAILED",
  );
});

test("explicit AirDNA activation registers the canonical airdna provider key", () => {
  const providers = builtInMarketPricingProviders({
    env: {
      PINGO_MARKET_PRICING_AIRDNA_ENABLED: "true",
      PINGO_MARKET_PRICING_AIRDNA_API_KEY: "test-key",
    },
  });

  assert.equal(providers.length, 1);
  assert.equal(providers[0].key, "airdna");
});

test("disabled market refresh never evaluates AirDNA credentials or provider activation", async () => {
  const runtime = createMarketPricingRefreshRuntime({
    env: {
      PINGO_MARKET_PRICING_REFRESH_ENABLED: "false",
      PINGO_MARKET_PRICING_AIRDNA_ENABLED: "true",
    },
  });

  assert.equal(runtime.enabled, false);
  assert.deepEqual(await runtime.runOnce(), { status: "DISABLED" });
});

test("enabled market refresh validates AirDNA composition before cycle execution", () => {
  assert.throws(
    () =>
      createMarketPricingRefreshRuntime({
        env: {
          PINGO_MARKET_PRICING_REFRESH_ENABLED: "true",
          PINGO_MARKET_PRICING_AIRDNA_ENABLED: "true",
        },
        prisma: {} as any,
      }),
    (error: unknown) =>
      error instanceof MarketPricingProviderError &&
      error.code === "AUTHENTICATION_FAILED",
  );
});
