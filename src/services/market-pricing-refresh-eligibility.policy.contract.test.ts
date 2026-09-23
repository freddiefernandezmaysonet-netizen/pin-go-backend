import assert from "node:assert/strict";
import test from "node:test";

import { evaluateMarketPricingRefreshEligibility } from "./market-pricing-refresh-eligibility.policy";

const now = new Date("2026-09-22T20:00:00.000Z");

test("a configured profile without a prior schedule is due immediately", () => {
  assert.deepEqual(
    evaluateMarketPricingRefreshEligibility({
      enabled: true,
      provider: "provider-a",
      nextRefreshAt: null,
      now,
    }),
    {
      eligible: true,
      reason: "FIRST_REFRESH_DUE",
      provider: "provider-a",
    },
  );
});

test("a scheduled profile becomes due exactly at nextRefreshAt", () => {
  assert.deepEqual(
    evaluateMarketPricingRefreshEligibility({
      enabled: true,
      provider: "provider-a",
      nextRefreshAt: new Date("2026-09-22T20:00:00.000Z"),
      now,
    }),
    {
      eligible: true,
      reason: "SCHEDULED_REFRESH_DUE",
      provider: "provider-a",
    },
  );
});

test("a refresh scheduled before now remains due", () => {
  assert.equal(
    evaluateMarketPricingRefreshEligibility({
      enabled: true,
      provider: "provider-a",
      nextRefreshAt: new Date("2026-09-22T19:59:59.999Z"),
      now,
    }).eligible,
    true,
  );
});

test("a future refresh is not selected early", () => {
  assert.deepEqual(
    evaluateMarketPricingRefreshEligibility({
      enabled: true,
      provider: "provider-a",
      nextRefreshAt: new Date("2026-09-22T20:00:00.001Z"),
      now,
    }),
    { eligible: false, reason: "NOT_DUE" },
  );
});

test("a disabled profile never creates autonomous work", () => {
  assert.deepEqual(
    evaluateMarketPricingRefreshEligibility({
      enabled: false,
      provider: "provider-a",
      nextRefreshAt: null,
      now,
    }),
    { eligible: false, reason: "DISABLED" },
  );
});

test("a profile without a provider remains safely inactive", () => {
  for (const provider of [null, "", "   "]) {
    assert.deepEqual(
      evaluateMarketPricingRefreshEligibility({
        enabled: true,
        provider,
        nextRefreshAt: null,
        now,
      }),
      { eligible: false, reason: "PROVIDER_NOT_CONFIGURED" },
    );
  }
});

test("the selected provider key is normalized once", () => {
  assert.deepEqual(
    evaluateMarketPricingRefreshEligibility({
      enabled: true,
      provider: "  provider-a  ",
      nextRefreshAt: null,
      now,
    }),
    {
      eligible: true,
      reason: "FIRST_REFRESH_DUE",
      provider: "provider-a",
    },
  );
});

test("invalid clock or schedule values fail closed", () => {
  assert.deepEqual(
    evaluateMarketPricingRefreshEligibility({
      enabled: true,
      provider: "provider-a",
      nextRefreshAt: null,
      now: new Date("invalid"),
    }),
    { eligible: false, reason: "INVALID_INPUT" },
  );
  assert.deepEqual(
    evaluateMarketPricingRefreshEligibility({
      enabled: true,
      provider: "provider-a",
      nextRefreshAt: new Date("invalid"),
      now,
    }),
    { eligible: false, reason: "INVALID_INPUT" },
  );
});
