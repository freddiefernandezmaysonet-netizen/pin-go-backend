import type { PrismaClient } from "@prisma/client";
import assert from "node:assert/strict";
import test from "node:test";

import { createPrismaMarketPricingRefreshCycleStateStore } from "./market-pricing-refresh-cycle.prisma-state-store";

const selectedAt = new Date("2026-09-22T18:00:00.000Z");
const nextAttemptAt = new Date("2026-09-22T19:00:00.000Z");

async function errorMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("EXPECTED_OPERATION_TO_REJECT");
}

function fixture(updatedCount = 1) {
  const calls: unknown[] = [];
  const prisma = {
    marketPricingProfile: {
      async updateMany(args: unknown): Promise<{ count: number }> {
        calls.push(args);
        return { count: updatedCount };
      },
    },
  } as unknown as PrismaClient;

  return {
    store: createPrismaMarketPricingRefreshCycleStateStore(prisma),
    calls,
  };
}

test("deferProfile atomically persists backoff only while the selected profile remains due", async () => {
  const subject = fixture();

  const deferred = await subject.store.deferProfile({
    profileId: " profile-1 ",
    selectedAt,
    nextAttemptAt,
    errorCode: " PROVIDER_UNAVAILABLE ",
  });

  assert.equal(deferred, true);
  assert.deepEqual(subject.calls, [
    {
      where: {
        id: "profile-1",
        enabled: true,
        OR: [{ nextRefreshAt: null }, { nextRefreshAt: { lte: selectedAt } }],
      },
      data: {
        nextRefreshAt: nextAttemptAt,
        lastErrorCode: "PROVIDER_UNAVAILABLE",
      },
    },
  ]);
});

test("deferProfile reports a lost compare-and-set without retrying", async () => {
  const subject = fixture(0);

  const deferred = await subject.store.deferProfile({
    profileId: "profile-1",
    selectedAt,
    nextAttemptAt,
    errorCode: "REFRESH_FAILED",
  });

  assert.equal(deferred, false);
  assert.equal(subject.calls.length, 1);
});

test("deferProfile does not treat an impossible multi-row update as success", async () => {
  const subject = fixture(2);

  const deferred = await subject.store.deferProfile({
    profileId: "profile-1",
    selectedAt,
    nextAttemptAt,
    errorCode: "REFRESH_FAILED",
  });

  assert.equal(deferred, false);
  assert.equal(subject.calls.length, 1);
});

test("deferProfile rejects a retry time that is not later than selection", async () => {
  const subject = fixture();

  const equalMessage = await errorMessage(
    subject.store.deferProfile({
      profileId: "profile-1",
      selectedAt,
      nextAttemptAt: new Date(selectedAt),
      errorCode: "REFRESH_FAILED",
    }),
  );
  const earlierMessage = await errorMessage(
    subject.store.deferProfile({
      profileId: "profile-1",
      selectedAt,
      nextAttemptAt: new Date(selectedAt.getTime() - 1),
      errorCode: "REFRESH_FAILED",
    }),
  );

  assert.equal(equalMessage, "MARKET_PRICING_DEFER_NEXT_ATTEMPT_NOT_FUTURE");
  assert.equal(earlierMessage, "MARKET_PRICING_DEFER_NEXT_ATTEMPT_NOT_FUTURE");
  assert.equal(subject.calls.length, 0);
});

test("deferProfile rejects invalid identity, dates, and error codes before Prisma", async () => {
  const subject = fixture();
  const validInput = {
    profileId: "profile-1",
    selectedAt,
    nextAttemptAt,
    errorCode: "REFRESH_FAILED",
  };

  assert.equal(
    await errorMessage(
      subject.store.deferProfile({ ...validInput, profileId: " " }),
    ),
    "MARKET_PRICING_DEFER_PROFILE_ID_REQUIRED",
  );
  assert.equal(
    await errorMessage(
      subject.store.deferProfile({
        ...validInput,
        selectedAt: new Date(Number.NaN),
      }),
    ),
    "MARKET_PRICING_DEFER_SELECTED_AT_INVALID",
  );
  assert.equal(
    await errorMessage(
      subject.store.deferProfile({
        ...validInput,
        nextAttemptAt: new Date(Number.NaN),
      }),
    ),
    "MARKET_PRICING_DEFER_NEXT_ATTEMPT_AT_INVALID",
  );
  assert.equal(
    await errorMessage(
      subject.store.deferProfile({ ...validInput, errorCode: "bad code" }),
    ),
    "MARKET_PRICING_DEFER_ERROR_CODE_INVALID",
  );
  assert.equal(subject.calls.length, 0);
});
