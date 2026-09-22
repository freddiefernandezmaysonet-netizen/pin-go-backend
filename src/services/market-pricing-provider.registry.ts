import type { MarketPricingProvider } from "./market-pricing-provider.contract";
import type { MarketPricingProviderRegistry } from "./market-pricing-refresh-cycle.service";

const PROVIDER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type MarketPricingRuntimeEnvironment = Readonly<
  Record<string, string | undefined>
>;

export function marketPricingRefreshEnabled(
  env: MarketPricingRuntimeEnvironment = {},
): boolean {
  return (
    String(env.PINGO_MARKET_PRICING_REFRESH_ENABLED ?? "false")
      .trim()
      .toLowerCase() === "true"
  );
}

function requireProviderKey(provider: MarketPricingProvider): string {
  const key = String(provider?.key ?? "");
  if (key !== key.trim() || !PROVIDER_KEY_PATTERN.test(key)) {
    throw new Error("MARKET_PRICING_PROVIDER_KEY_INVALID");
  }
  return key;
}

export function createMarketPricingProviderRegistry(input: {
  enabled: boolean;
  providers: readonly MarketPricingProvider[];
}): MarketPricingProviderRegistry {
  if (typeof input?.enabled !== "boolean" || !Array.isArray(input.providers)) {
    throw new Error("MARKET_PRICING_PROVIDER_REGISTRY_INPUT_INVALID");
  }

  const providersByKey = new Map<string, MarketPricingProvider>();
  for (const provider of input.providers) {
    const key = requireProviderKey(provider);
    if (providersByKey.has(key)) {
      throw new Error("MARKET_PRICING_PROVIDER_KEY_DUPLICATED");
    }
    providersByKey.set(key, provider);
  }

  return {
    resolve(provider: string): MarketPricingProvider | null {
      if (!input.enabled) return null;

      const key = String(provider ?? "").trim();
      if (!PROVIDER_KEY_PATTERN.test(key)) return null;
      return providersByKey.get(key) ?? null;
    },
  };
}

export function createMarketPricingProviderRuntime(
  input: {
    env?: MarketPricingRuntimeEnvironment;
    providers?: readonly MarketPricingProvider[];
  } = {},
): {
  enabled: boolean;
  registry: MarketPricingProviderRegistry;
} {
  const enabled = marketPricingRefreshEnabled(input.env);
  return {
    enabled,
    registry: createMarketPricingProviderRegistry({
      enabled,
      providers: input.providers ?? [],
    }),
  };
}
