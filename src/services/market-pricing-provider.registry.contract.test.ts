import assert from "node:assert/strict";
import test from "node:test";

import type { MarketPricingProvider } from "./market-pricing-provider.contract";
import {
  createMarketPricingProviderRegistry,
  createMarketPricingProviderRuntime,
  marketPricingRefreshEnabled,
} from "./market-pricing-provider.registry";

function provider(key: string): MarketPricingProvider {
  return {
    key,
    async fetchMarketPricing() {
      throw new Error("PROVIDER_MUST_NOT_BE_CALLED_BY_REGISTRY_TEST");
    },
  };
}

function errorMessage(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("EXPECTED_OPERATION_TO_REJECT");
}

test("market pricing refresh is disabled when the flag is absent", () => {
  assert.equal(marketPricingRefreshEnabled(), false);
  assert.equal(marketPricingRefreshEnabled({}), false);
});

test("market pricing refresh only accepts an explicit true flag", () => {
  assert.equal(
    marketPricingRefreshEnabled({
      PINGO_MARKET_PRICING_REFRESH_ENABLED: " TRUE ",
    }),
    true,
  );
  for (const value of ["false", "1", "yes", "enabled", ""]) {
    assert.equal(
      marketPricingRefreshEnabled({
        PINGO_MARKET_PRICING_REFRESH_ENABLED: value,
      }),
      false,
    );
  }
});

test("runtime composition remains disabled and empty by default", () => {
  const runtime = createMarketPricingProviderRuntime();

  assert.equal(runtime.enabled, false);
  assert.equal(runtime.registry.resolve("ANY_PROVIDER"), null);
});

test("a disabled registry never exposes a registered provider or changes after input mutation", () => {
  const knownProvider = provider("provider-a");
  const input = { enabled: false, providers: [knownProvider] };
  const registry = createMarketPricingProviderRegistry(input);

  input.enabled = true;

  assert.equal(registry.resolve("provider-a"), null);
});

test("an enabled registry resolves only the exact registered provider key", () => {
  const knownProvider = provider("provider-a");
  const registry = createMarketPricingProviderRegistry({
    enabled: true,
    providers: [knownProvider],
  });

  assert.equal(registry.resolve("provider-a"), knownProvider);
  assert.equal(registry.resolve(" provider-a "), knownProvider);
  assert.equal(registry.resolve("PROVIDER-A"), null);
  assert.equal(registry.resolve("unknown"), null);
  assert.equal(registry.resolve(""), null);
});

test("runtime composition exposes registered providers only after explicit activation", () => {
  const knownProvider = provider("provider-a");
  const runtime = createMarketPricingProviderRuntime({
    env: { PINGO_MARKET_PRICING_REFRESH_ENABLED: "true" },
    providers: [knownProvider],
  });

  assert.equal(runtime.enabled, true);
  assert.equal(runtime.registry.resolve("provider-a"), knownProvider);
});

test("registry rejects unsafe or silently normalized provider keys", () => {
  for (const key of [
    "",
    " provider-a",
    "provider a",
    "provider/a",
    "a".repeat(65),
  ]) {
    assert.equal(
      errorMessage(() =>
        createMarketPricingProviderRegistry({
          enabled: false,
          providers: [provider(key)],
        }),
      ),
      "MARKET_PRICING_PROVIDER_KEY_INVALID",
    );
  }
});

test("registry rejects duplicate keys and malformed composition input", () => {
  assert.equal(
    errorMessage(() =>
      createMarketPricingProviderRegistry({
        enabled: true,
        providers: [provider("provider-a"), provider("provider-a")],
      }),
    ),
    "MARKET_PRICING_PROVIDER_KEY_DUPLICATED",
  );
  assert.equal(
    errorMessage(() =>
      createMarketPricingProviderRegistry({
        enabled: true,
        providers: null as unknown as readonly MarketPricingProvider[],
      }),
    ),
    "MARKET_PRICING_PROVIDER_REGISTRY_INPUT_INVALID",
  );
});
