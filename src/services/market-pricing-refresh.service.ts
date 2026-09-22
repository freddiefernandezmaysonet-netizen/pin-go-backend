import {
  MarketPricingProviderError,
  type MarketComparableCandidate,
  type MarketPricingProvider,
  type MarketPricingProviderRequest,
  type MarketPricingProviderResult,
} from "./market-pricing-provider.contract";
import {
  validateMarketPricingProviderResult,
  type MarketPricingProviderValidationIssue,
} from "./market-pricing-provider-validation.policy";
import {
  deriveMarketPricingSnapshot,
  type MarketPricingAggressiveness,
  type MarketPricingPosition,
  type MarketPricingSnapshotEvidence,
  type MarketPricingStrategy,
} from "./market-pricing-snapshot-derivation.policy";

export type MarketPricingRefreshConfiguration = {
  profileId: string;
  strategy: MarketPricingStrategy;
  position: MarketPricingPosition;
  aggressiveness: MarketPricingAggressiveness;
};

export type DerivedMarketPricingSnapshot = {
  stayDate: string;
  currency: string;
  sampleSize: number;
  availableCount: number;
  lowerRate: number | null;
  medianRate: number;
  upperRate: number | null;
  targetRate: number;
  confidence: number;
  observedAt: Date;
  expiresAt: Date;
  evidence: MarketPricingSnapshotEvidence & {
    providerSuggestedRate: number | null;
  };
};

export type MarketPricingRefreshStore = {
  createRun(input: {
    profileId: string;
    provider: string;
    requestedDateFrom: string;
    requestedDateToExclusive: string;
    startedAt: Date;
  }): Promise<{ runId: string }>;
  completeRunAtomically(input: {
    runId: string;
    profileId: string;
    provider: string;
    providerRequestId: string | null;
    comparables: MarketComparableCandidate[];
    snapshots: DerivedMarketPricingSnapshot[];
    completedAt: Date;
  }): Promise<{
    snapshotCount: number;
    changedDateKeys: string[];
  }>;
  failRun(input: {
    runId: string;
    errorCode: string;
    errorSummary: string;
    completedAt: Date;
  }): Promise<void>;
};

export type MarketPricingRefreshResult =
  | {
      status: "SUCCEEDED";
      runId: string;
      snapshotCount: number;
      changedDateKeys: string[];
    }
  | {
      status: "FAILED";
      runId: string;
      errorCode: string;
    };

const MAX_ERROR_SUMMARY_LENGTH = 500;

function requireNonEmpty(value: string, code: string): string {
  const clean = String(value ?? "").trim();
  if (!clean) throw new Error(code);
  return clean;
}

function requireValidDate(value: Date, code: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(code);
  }
  return value;
}

function safeErrorSummary(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_SUMMARY_LENGTH);
}

function validationSummary(
  issues: MarketPricingProviderValidationIssue[]
): string {
  return safeErrorSummary(
    issues
      .slice(0, 10)
      .map((issue) => `${issue.code}:${issue.path}`)
      .join(", ")
  );
}

function deriveSnapshots(input: {
  result: MarketPricingProviderResult;
  strategy: MarketPricingStrategy;
  position: MarketPricingPosition;
  aggressiveness: MarketPricingAggressiveness;
}): DerivedMarketPricingSnapshot[] | null {
  const snapshots: DerivedMarketPricingSnapshot[] = [];

  for (const observation of input.result.observations) {
    const derivation = deriveMarketPricingSnapshot({
      observation,
      comparables: input.result.comparables,
      strategy: input.strategy,
      position: input.position,
      aggressiveness: input.aggressiveness,
    });

    if (!derivation.derived) return null;

    snapshots.push({
      stayDate: observation.stayDate,
      currency: observation.currency,
      sampleSize: observation.sampleSize,
      availableCount: observation.availableCount,
      lowerRate: observation.lowerRate,
      medianRate: observation.medianRate,
      upperRate: observation.upperRate,
      targetRate: derivation.targetRate,
      confidence: derivation.confidence,
      observedAt: input.result.observedAt,
      expiresAt: input.result.expiresAt,
      evidence: {
        ...derivation.evidence,
        providerSuggestedRate: observation.providerSuggestedRate,
      },
    });
  }

  return snapshots;
}

function providerErrorDetails(error: unknown): {
  code: string;
  summary: string;
} {
  if (error instanceof MarketPricingProviderError) {
    return {
      code: error.code,
      summary: safeErrorSummary(error.message || error.code),
    };
  }

  return {
    code: "UNEXPECTED_PROVIDER_ERROR",
    summary: "Market pricing provider refresh failed without a safe provider error.",
  };
}

async function recordFailure(input: {
  store: MarketPricingRefreshStore;
  runId: string;
  errorCode: string;
  errorSummary: string;
  completedAt: Date;
}): Promise<void> {
  try {
    await input.store.failRun({
      runId: input.runId,
      errorCode: input.errorCode,
      errorSummary: safeErrorSummary(input.errorSummary),
      completedAt: input.completedAt,
    });
  } catch {
    // Preserve the original failure. A stale-run reconciler can close the run.
  }
}

export async function refreshMarketPricing(input: {
  provider: MarketPricingProvider;
  store: MarketPricingRefreshStore;
  request: MarketPricingProviderRequest;
  configuration: MarketPricingRefreshConfiguration;
  now?: Date;
  clock?: () => Date;
}): Promise<MarketPricingRefreshResult> {
  const clock = input.clock ?? (() => new Date());
  const providerKey = requireNonEmpty(
    input.provider.key,
    "MARKET_PRICING_PROVIDER_KEY_REQUIRED"
  );
  const profileId = requireNonEmpty(
    input.configuration.profileId,
    "MARKET_PRICING_PROFILE_ID_REQUIRED"
  );
  const startedAt = requireValidDate(
    input.now ?? clock(),
    "MARKET_PRICING_REFRESH_NOW_INVALID"
  );
  const run = await input.store.createRun({
    profileId,
    provider: providerKey,
    requestedDateFrom: input.request.dateFrom,
    requestedDateToExclusive: input.request.dateToExclusive,
    startedAt,
  });
  const runId = requireNonEmpty(
    run.runId,
    "MARKET_PRICING_RUN_ID_REQUIRED"
  );

  let providerResult: MarketPricingProviderResult;
  try {
    providerResult = await input.provider.fetchMarketPricing(input.request);
  } catch (error) {
    const details = providerErrorDetails(error);
    await recordFailure({
      store: input.store,
      runId,
      errorCode: details.code,
      errorSummary: details.summary,
      completedAt: clock(),
    });
    return { status: "FAILED", runId, errorCode: details.code };
  }

  const validation = validateMarketPricingProviderResult({
    expectedProvider: providerKey,
    request: input.request,
    result: providerResult,
  });
  if (!validation.valid) {
    await recordFailure({
      store: input.store,
      runId,
      errorCode: "INVALID_RESPONSE",
      errorSummary: validationSummary(validation.issues),
      completedAt: clock(),
    });
    return { status: "FAILED", runId, errorCode: "INVALID_RESPONSE" };
  }

  const snapshots = deriveSnapshots({
    result: validation.value,
    strategy: input.configuration.strategy,
    position: input.configuration.position,
    aggressiveness: input.configuration.aggressiveness,
  });
  if (!snapshots) {
    await recordFailure({
      store: input.store,
      runId,
      errorCode: "DERIVATION_FAILED",
      errorSummary: "Validated market observations could not be derived safely.",
      completedAt: clock(),
    });
    return { status: "FAILED", runId, errorCode: "DERIVATION_FAILED" };
  }

  try {
    const persisted = await input.store.completeRunAtomically({
      runId,
      profileId,
      provider: providerKey,
      providerRequestId: validation.value.providerRequestId,
      comparables: validation.value.comparables,
      snapshots,
      completedAt: clock(),
    });

    return {
      status: "SUCCEEDED",
      runId,
      snapshotCount: persisted.snapshotCount,
      changedDateKeys: [...persisted.changedDateKeys].sort(),
    };
  } catch {
    await recordFailure({
      store: input.store,
      runId,
      errorCode: "PERSISTENCE_FAILED",
      errorSummary: "Atomic market pricing snapshot persistence failed.",
      completedAt: clock(),
    });
    return { status: "FAILED", runId, errorCode: "PERSISTENCE_FAILED" };
  }
}
