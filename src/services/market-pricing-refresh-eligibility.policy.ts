export type MarketPricingRefreshEligibilityReason =
  | "FIRST_REFRESH_DUE"
  | "SCHEDULED_REFRESH_DUE"
  | "DISABLED"
  | "PROVIDER_NOT_CONFIGURED"
  | "NOT_DUE"
  | "INVALID_INPUT";

export type MarketPricingRefreshEligibilityInput = {
  enabled: boolean;
  provider: string | null;
  nextRefreshAt: Date | null;
  now: Date;
};

export type MarketPricingRefreshEligibilityResult =
  | {
      eligible: true;
      reason: "FIRST_REFRESH_DUE" | "SCHEDULED_REFRESH_DUE";
      provider: string;
    }
  | {
      eligible: false;
      reason:
        | "DISABLED"
        | "PROVIDER_NOT_CONFIGURED"
        | "NOT_DUE"
        | "INVALID_INPUT";
    };

function isValidDate(value: Date): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function evaluateMarketPricingRefreshEligibility(
  input: MarketPricingRefreshEligibilityInput,
): MarketPricingRefreshEligibilityResult {
  if (!input || typeof input.enabled !== "boolean" || !isValidDate(input.now)) {
    return { eligible: false, reason: "INVALID_INPUT" };
  }

  if (input.nextRefreshAt !== null && !isValidDate(input.nextRefreshAt)) {
    return { eligible: false, reason: "INVALID_INPUT" };
  }

  if (!input.enabled) {
    return { eligible: false, reason: "DISABLED" };
  }

  const provider = String(input.provider ?? "").trim();
  if (!provider) {
    return { eligible: false, reason: "PROVIDER_NOT_CONFIGURED" };
  }

  if (input.nextRefreshAt === null) {
    return {
      eligible: true,
      reason: "FIRST_REFRESH_DUE",
      provider,
    };
  }

  if (input.nextRefreshAt.getTime() <= input.now.getTime()) {
    return {
      eligible: true,
      reason: "SCHEDULED_REFRESH_DUE",
      provider,
    };
  }

  return { eligible: false, reason: "NOT_DUE" };
}
