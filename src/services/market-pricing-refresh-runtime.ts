import type { PrismaClient } from "@prisma/client";

import type { MarketPricingProvider } from "./market-pricing-provider.contract";
import {
  createMarketPricingProviderRegistry,
  type MarketPricingRuntimeEnvironment,
} from "./market-pricing-provider.registry";
import { createPrismaMarketPricingRefreshCandidateRepository } from "./market-pricing-refresh-candidate.prisma-repository";
import {
  resolveMarketPricingRefreshCycleConfig,
  type MarketPricingRefreshCycleConfig,
} from "./market-pricing-refresh-cycle.config";
import { createPrismaMarketPricingRefreshCycleStateStore } from "./market-pricing-refresh-cycle.prisma-state-store";
import {
  runMarketPricingRefreshCycle,
  type MarketPricingRefreshCycleResult,
} from "./market-pricing-refresh-cycle.service";
import { createPrismaMarketPricingRefreshStore } from "./market-pricing-refresh.prisma-store";

export type MarketPricingRefreshRuntimeRunResult =
  | { status: "DISABLED" }
  | {
      status: "EXECUTED";
      cycle: MarketPricingRefreshCycleResult;
    };

export type MarketPricingRefreshRuntime = {
  readonly enabled: boolean;
  readonly config: MarketPricingRefreshCycleConfig;
  runOnce(): Promise<MarketPricingRefreshRuntimeRunResult>;
};

export function createMarketPricingRefreshRuntime(input: {
  env?: MarketPricingRuntimeEnvironment;
  prisma?: PrismaClient;
  providers?: readonly MarketPricingProvider[];
  clock?: () => Date;
} = {}): MarketPricingRefreshRuntime {
  const config = resolveMarketPricingRefreshCycleConfig(input.env);

  if (!config.enabled) {
    return Object.freeze({
      enabled: false,
      config,
      async runOnce(): Promise<MarketPricingRefreshRuntimeRunResult> {
        return { status: "DISABLED" };
      },
    });
  }

  if (!input.prisma) {
    throw new Error("MARKET_PRICING_REFRESH_PRISMA_REQUIRED");
  }

  const providerRegistry = createMarketPricingProviderRegistry({
    enabled: true,
    providers: input.providers ?? [],
  });
  const candidateRepository =
    createPrismaMarketPricingRefreshCandidateRepository(input.prisma);
  const refreshStore = createPrismaMarketPricingRefreshStore(input.prisma);
  const stateStore =
    createPrismaMarketPricingRefreshCycleStateStore(input.prisma);

  return Object.freeze({
    enabled: true,
    config,
    async runOnce(): Promise<MarketPricingRefreshRuntimeRunResult> {
      const cycle = await runMarketPricingRefreshCycle({
        candidateRepository,
        refreshStore,
        stateStore,
        providerRegistry,
        ...(input.clock ? { clock: input.clock } : {}),
        batchSize: config.batchSize,
        horizonDays: config.horizonDays,
        retryBackoffMs: config.retryBackoffMs,
        blockedBackoffMs: config.blockedBackoffMs,
      });
      return { status: "EXECUTED", cycle };
    },
  });
}
