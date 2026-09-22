import type { MarketPricingProvider } from "./market-pricing-provider.contract";
import type {
  MarketPricingRefreshCandidate,
  MarketPricingRefreshCandidateRepository,
} from "./market-pricing-refresh-candidate.prisma-repository";
import {
  refreshMarketPricing,
  type MarketPricingRefreshStore,
} from "./market-pricing-refresh.service";

export type MarketPricingProviderRegistry = {
  resolve(provider: string): MarketPricingProvider | null;
};

export type MarketPricingRefreshCycleStateStore = {
  deferProfile(input: {
    profileId: string;
    selectedAt: Date;
    nextAttemptAt: Date;
    errorCode: string;
  }): Promise<boolean>;
};

export type MarketPricingRefreshCycleItemStatus =
  | "SUCCEEDED"
  | "REFRESH_FAILED"
  | "BLOCKED"
  | "PROVIDER_UNAVAILABLE"
  | "ALREADY_RUNNING"
  | "EXECUTION_FAILED";

export type MarketPricingRefreshCycleItem = {
  profileId: string;
  propertyId: string;
  provider: string;
  status: MarketPricingRefreshCycleItemStatus;
  errorCode: string | null;
  deferred: boolean;
};

export type MarketPricingRefreshCycleResult = {
  selectedCount: number;
  attemptedCount: number;
  succeededCount: number;
  failedCount: number;
  blockedCount: number;
  skippedCount: number;
  deferralFailureCount: number;
  items: MarketPricingRefreshCycleItem[];
};

function requireValidDate(value: Date, code: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(code);
  }
  return value;
}

function requireIntegerInRange(
  value: number,
  maximum: number,
  code: string,
): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(code);
  }
  return value;
}

function nextAttemptAt(settledAt: Date, backoffMs: number): Date {
  return new Date(settledAt.getTime() + backoffMs);
}

async function deferSafely(input: {
  stateStore: MarketPricingRefreshCycleStateStore;
  profileId: string;
  selectedAt: Date;
  settledAt: Date;
  backoffMs: number;
  errorCode: string;
}): Promise<boolean> {
  try {
    return await input.stateStore.deferProfile({
      profileId: input.profileId,
      selectedAt: input.selectedAt,
      nextAttemptAt: nextAttemptAt(input.settledAt, input.backoffMs),
      errorCode: input.errorCode,
    });
  } catch {
    return false;
  }
}

function summarize(
  items: MarketPricingRefreshCycleItem[],
): MarketPricingRefreshCycleResult {
  return {
    selectedCount: items.length,
    attemptedCount: items.filter(
      (item) =>
        item.status === "SUCCEEDED" ||
        item.status === "REFRESH_FAILED" ||
        item.status === "EXECUTION_FAILED",
    ).length,
    succeededCount: items.filter((item) => item.status === "SUCCEEDED").length,
    failedCount: items.filter(
      (item) =>
        item.status === "REFRESH_FAILED" ||
        item.status === "PROVIDER_UNAVAILABLE" ||
        item.status === "EXECUTION_FAILED",
    ).length,
    blockedCount: items.filter((item) => item.status === "BLOCKED").length,
    skippedCount: items.filter((item) => item.status === "ALREADY_RUNNING")
      .length,
    deferralFailureCount: items.filter(
      (item) => item.errorCode !== null && !item.deferred,
    ).length,
    items,
  };
}

function blockedItem(
  candidate: Extract<MarketPricingRefreshCandidate, { status: "BLOCKED" }>,
  deferred: boolean,
): MarketPricingRefreshCycleItem {
  return {
    profileId: candidate.profileId,
    propertyId: candidate.propertyId,
    provider: candidate.provider,
    status: "BLOCKED",
    errorCode: candidate.reason,
    deferred,
  };
}

export async function runMarketPricingRefreshCycle(input: {
  candidateRepository: MarketPricingRefreshCandidateRepository;
  refreshStore: MarketPricingRefreshStore;
  stateStore: MarketPricingRefreshCycleStateStore;
  providerRegistry: MarketPricingProviderRegistry;
  now?: Date;
  clock?: () => Date;
  batchSize: number;
  horizonDays: number;
  currency: string;
  retryBackoffMs: number;
  blockedBackoffMs: number;
}): Promise<MarketPricingRefreshCycleResult> {
  const clock = input.clock ?? (() => new Date());
  const selectedAt = requireValidDate(
    input.now ?? clock(),
    "MARKET_PRICING_CYCLE_NOW_INVALID",
  );
  const batchSize = requireIntegerInRange(
    input.batchSize,
    100,
    "MARKET_PRICING_CYCLE_BATCH_SIZE_INVALID",
  );
  const horizonDays = requireIntegerInRange(
    input.horizonDays,
    730,
    "MARKET_PRICING_CYCLE_HORIZON_INVALID",
  );
  const retryBackoffMs = requireIntegerInRange(
    input.retryBackoffMs,
    30 * 24 * 60 * 60 * 1000,
    "MARKET_PRICING_CYCLE_RETRY_BACKOFF_INVALID",
  );
  const blockedBackoffMs = requireIntegerInRange(
    input.blockedBackoffMs,
    30 * 24 * 60 * 60 * 1000,
    "MARKET_PRICING_CYCLE_BLOCKED_BACKOFF_INVALID",
  );

  const candidates = await input.candidateRepository.listDue({
    now: selectedAt,
    limit: batchSize,
    horizonDays,
    currency: input.currency,
  });
  const items: MarketPricingRefreshCycleItem[] = [];

  for (const candidate of candidates) {
    if (candidate.status === "BLOCKED") {
      const settledAt = requireValidDate(
        clock(),
        "MARKET_PRICING_CYCLE_CLOCK_INVALID",
      );
      const deferred = await deferSafely({
        stateStore: input.stateStore,
        profileId: candidate.profileId,
        selectedAt,
        settledAt,
        backoffMs: blockedBackoffMs,
        errorCode: candidate.reason,
      });
      items.push(blockedItem(candidate, deferred));
      continue;
    }

    let provider: MarketPricingProvider | null = null;
    try {
      provider = input.providerRegistry.resolve(candidate.provider);
    } catch {
      provider = null;
    }
    const providerKey = String(provider?.key ?? "").trim();
    if (!provider || providerKey !== candidate.provider) {
      const errorCode = provider
        ? "MARKET_PRICING_PROVIDER_KEY_MISMATCH"
        : "MARKET_PRICING_PROVIDER_UNAVAILABLE";
      const settledAt = requireValidDate(
        clock(),
        "MARKET_PRICING_CYCLE_CLOCK_INVALID",
      );
      const deferred = await deferSafely({
        stateStore: input.stateStore,
        profileId: candidate.profileId,
        selectedAt,
        settledAt,
        backoffMs: blockedBackoffMs,
        errorCode,
      });
      items.push({
        profileId: candidate.profileId,
        propertyId: candidate.propertyId,
        provider: candidate.provider,
        status: "PROVIDER_UNAVAILABLE",
        errorCode,
        deferred,
      });
      continue;
    }

    try {
      const refresh = await refreshMarketPricing({
        provider,
        store: input.refreshStore,
        request: candidate.request,
        configuration: candidate.configuration,
        now: requireValidDate(clock(), "MARKET_PRICING_CYCLE_CLOCK_INVALID"),
        clock,
      });
      if (refresh.status === "SUCCEEDED") {
        items.push({
          profileId: candidate.profileId,
          propertyId: candidate.propertyId,
          provider: candidate.provider,
          status: "SUCCEEDED",
          errorCode: null,
          deferred: false,
        });
        continue;
      }

      const settledAt = requireValidDate(
        clock(),
        "MARKET_PRICING_CYCLE_CLOCK_INVALID",
      );
      const deferred = await deferSafely({
        stateStore: input.stateStore,
        profileId: candidate.profileId,
        selectedAt,
        settledAt,
        backoffMs: retryBackoffMs,
        errorCode: refresh.errorCode,
      });
      items.push({
        profileId: candidate.profileId,
        propertyId: candidate.propertyId,
        provider: candidate.provider,
        status: "REFRESH_FAILED",
        errorCode: refresh.errorCode,
        deferred,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "MARKET_PRICING_REFRESH_ALREADY_RUNNING") {
        items.push({
          profileId: candidate.profileId,
          propertyId: candidate.propertyId,
          provider: candidate.provider,
          status: "ALREADY_RUNNING",
          errorCode: null,
          deferred: false,
        });
        continue;
      }

      const errorCode = "MARKET_PRICING_REFRESH_EXECUTION_FAILED";
      const settledAt = requireValidDate(
        clock(),
        "MARKET_PRICING_CYCLE_CLOCK_INVALID",
      );
      const deferred = await deferSafely({
        stateStore: input.stateStore,
        profileId: candidate.profileId,
        selectedAt,
        settledAt,
        backoffMs: retryBackoffMs,
        errorCode,
      });
      items.push({
        profileId: candidate.profileId,
        propertyId: candidate.propertyId,
        provider: candidate.provider,
        status: "EXECUTION_FAILED",
        errorCode,
        deferred,
      });
    }
  }

  return summarize(items);
}
