import type { PrismaClient } from "@prisma/client";

import type { MarketPricingRefreshCycleStateStore } from "./market-pricing-refresh-cycle.service";

const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,120}$/;

function requireNonEmpty(value: string, code: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(code);
  }
  return normalized;
}

function requireValidDate(value: Date, code: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(code);
  }
  return value;
}

function requireErrorCode(value: string): string {
  const normalized = requireNonEmpty(
    value,
    "MARKET_PRICING_DEFER_ERROR_CODE_INVALID",
  );
  if (!ERROR_CODE_PATTERN.test(normalized)) {
    throw new Error("MARKET_PRICING_DEFER_ERROR_CODE_INVALID");
  }
  return normalized;
}

export function createPrismaMarketPricingRefreshCycleStateStore(
  prisma: PrismaClient,
): MarketPricingRefreshCycleStateStore {
  return {
    async deferProfile(input): Promise<boolean> {
      const profileId = requireNonEmpty(
        input.profileId,
        "MARKET_PRICING_DEFER_PROFILE_ID_REQUIRED",
      );
      const selectedAt = requireValidDate(
        input.selectedAt,
        "MARKET_PRICING_DEFER_SELECTED_AT_INVALID",
      );
      const nextAttemptAt = requireValidDate(
        input.nextAttemptAt,
        "MARKET_PRICING_DEFER_NEXT_ATTEMPT_AT_INVALID",
      );
      if (nextAttemptAt.getTime() <= selectedAt.getTime()) {
        throw new Error("MARKET_PRICING_DEFER_NEXT_ATTEMPT_NOT_FUTURE");
      }
      const errorCode = requireErrorCode(input.errorCode);

      const updated = await prisma.marketPricingProfile.updateMany({
        where: {
          id: profileId,
          enabled: true,
          OR: [{ nextRefreshAt: null }, { nextRefreshAt: { lte: selectedAt } }],
        },
        data: {
          nextRefreshAt: nextAttemptAt,
          lastErrorCode: errorCode,
        },
      });

      return updated.count === 1;
    },
  };
}
