import {
  marketPricingRefreshEnabled,
  type MarketPricingRuntimeEnvironment,
} from "./market-pricing-provider.registry";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type MarketPricingRefreshCycleConfig =
  | { enabled: false }
  | {
      enabled: true;
      batchSize: number;
      horizonDays: number;
      retryBackoffMs: number;
      blockedBackoffMs: number;
    };

function parseInteger(input: {
  name: string;
  rawValue: string | undefined;
  fallback: number;
  minimum: number;
  maximum: number;
}): number {
  const raw = String(input.rawValue ?? "").trim();
  const value = raw ? Number(raw) : input.fallback;
  if (
    !Number.isSafeInteger(value) ||
    value < input.minimum ||
    value > input.maximum
  ) {
    throw new Error(`${input.name}_INVALID`);
  }
  return value;
}

export function resolveMarketPricingRefreshCycleConfig(
  env: MarketPricingRuntimeEnvironment = {},
): MarketPricingRefreshCycleConfig {
  if (!marketPricingRefreshEnabled(env)) {
    return { enabled: false };
  }

  const retryBackoffMs = parseInteger({
    name: "PINGO_MARKET_PRICING_REFRESH_RETRY_BACKOFF_MS",
    rawValue: env.PINGO_MARKET_PRICING_REFRESH_RETRY_BACKOFF_MS,
    fallback: 15 * MINUTE_MS,
    minimum: MINUTE_MS,
    maximum: 30 * DAY_MS,
  });
  const blockedBackoffMs = parseInteger({
    name: "PINGO_MARKET_PRICING_REFRESH_BLOCKED_BACKOFF_MS",
    rawValue: env.PINGO_MARKET_PRICING_REFRESH_BLOCKED_BACKOFF_MS,
    fallback: DAY_MS,
    minimum: 5 * MINUTE_MS,
    maximum: 30 * DAY_MS,
  });
  if (blockedBackoffMs < retryBackoffMs) {
    throw new Error("PINGO_MARKET_PRICING_REFRESH_BACKOFF_ORDER_INVALID");
  }

  return {
    enabled: true,
    batchSize: parseInteger({
      name: "PINGO_MARKET_PRICING_REFRESH_BATCH_SIZE",
      rawValue: env.PINGO_MARKET_PRICING_REFRESH_BATCH_SIZE,
      fallback: 10,
      minimum: 1,
      maximum: 100,
    }),
    horizonDays: parseInteger({
      name: "PINGO_MARKET_PRICING_REFRESH_HORIZON_DAYS",
      rawValue: env.PINGO_MARKET_PRICING_REFRESH_HORIZON_DAYS,
      fallback: 365,
      minimum: 1,
      maximum: 730,
    }),
    retryBackoffMs,
    blockedBackoffMs,
  };
}
