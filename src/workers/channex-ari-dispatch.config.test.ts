import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEX_ARI_DISPATCH_DEFAULT_POLL_MS,
  resolveChannexAriDispatchConfig,
} from "./channex-ari-dispatch.config";
import { CHANNEX_ARI_DEFAULT_LEASE_MS } from "../pms/outbound/channex-ari-dispatch.policy";
import { CHANNEX_ARI_EXECUTOR_COMPLETION_RESERVE_MS } from "../pms/outbound/channex-ari-delivery-executor.service";
import { CHANNEX_ARI_HTTP_DEFAULT_TIMEOUT_MS } from "../pms/outbound/channex-ari-http.client";
import { CHANNEX_ARI_DEFAULT_SELECTION_LIMIT } from "../pms/outbound/channex-ari-job-selection.policy";

test("resolves certified defaults without reading secrets", () => {
  const result = resolveChannexAriDispatchConfig({
    CHANNEX_API_KEY: "must-not-be-returned",
    PMS_CREDENTIALS_SECRET: "must-not-be-returned-either",
  } as NodeJS.ProcessEnv);

  assert.deepEqual(result, {
    pollMs: CHANNEX_ARI_DISPATCH_DEFAULT_POLL_MS,
    selectionLimit: CHANNEX_ARI_DEFAULT_SELECTION_LIMIT,
    candidateScanLimit: CHANNEX_ARI_DEFAULT_SELECTION_LIMIT * 10,
    leaseMs: CHANNEX_ARI_DEFAULT_LEASE_MS,
    timeoutMs: CHANNEX_ARI_HTTP_DEFAULT_TIMEOUT_MS,
    completionReserveMs: CHANNEX_ARI_EXECUTOR_COMPLETION_RESERVE_MS,
    jitterMs: 0,
  });
  assert.equal(JSON.stringify(result).includes("must-not-be-returned"), false);
});

test("resolves explicit bounded operational values", () => {
  const env = {
    CHANNEX_ARI_DISPATCH_POLL_MS: "15000",
    CHANNEX_ARI_DISPATCH_SELECTION_LIMIT: "40",
    CHANNEX_ARI_DISPATCH_CANDIDATE_SCAN_LIMIT: "400",
    CHANNEX_ARI_DISPATCH_LEASE_MS: "180000",
    CHANNEX_ARI_DISPATCH_HTTP_TIMEOUT_MS: "30000",
    CHANNEX_ARI_DISPATCH_COMPLETION_RESERVE_MS: "10000",
    CHANNEX_ARI_DISPATCH_JITTER_MS: "2500",
  } as NodeJS.ProcessEnv;
  const before = { ...env };

  assert.deepEqual(resolveChannexAriDispatchConfig(env), {
    pollMs: 15_000,
    selectionLimit: 40,
    candidateScanLimit: 400,
    leaseMs: 180_000,
    timeoutMs: 30_000,
    completionReserveMs: 10_000,
    jitterMs: 2_500,
  });
  assert.deepEqual(env, before);
});

test("derives the default scan limit from the explicit selection limit", () => {
  assert.equal(
    resolveChannexAriDispatchConfig({
      CHANNEX_ARI_DISPATCH_SELECTION_LIMIT: "60",
    } as NodeJS.ProcessEnv).candidateScanLimit,
    600
  );

  assert.equal(
    resolveChannexAriDispatchConfig({
      CHANNEX_ARI_DISPATCH_SELECTION_LIMIT: "100",
    } as NodeJS.ProcessEnv).candidateScanLimit,
    1000
  );
});

test("accepts boundary values permitted by certified contracts", () => {
  assert.deepEqual(
    resolveChannexAriDispatchConfig({
      CHANNEX_ARI_DISPATCH_POLL_MS: "1000",
      CHANNEX_ARI_DISPATCH_SELECTION_LIMIT: "1",
      CHANNEX_ARI_DISPATCH_CANDIDATE_SCAN_LIMIT: "1",
      CHANNEX_ARI_DISPATCH_LEASE_MS: "30000",
      CHANNEX_ARI_DISPATCH_HTTP_TIMEOUT_MS: "1000",
      CHANNEX_ARI_DISPATCH_COMPLETION_RESERVE_MS: "0",
      CHANNEX_ARI_DISPATCH_JITTER_MS: "0",
    } as NodeJS.ProcessEnv),
    {
      pollMs: 1_000,
      selectionLimit: 1,
      candidateScanLimit: 1,
      leaseMs: 30_000,
      timeoutMs: 1_000,
      completionReserveMs: 0,
      jitterMs: 0,
    }
  );

  assert.deepEqual(
    resolveChannexAriDispatchConfig({
      CHANNEX_ARI_DISPATCH_POLL_MS: "300000",
      CHANNEX_ARI_DISPATCH_SELECTION_LIMIT: "100",
      CHANNEX_ARI_DISPATCH_CANDIDATE_SCAN_LIMIT: "1000",
      CHANNEX_ARI_DISPATCH_LEASE_MS: "300000",
      CHANNEX_ARI_DISPATCH_HTTP_TIMEOUT_MS: "120000",
      CHANNEX_ARI_DISPATCH_COMPLETION_RESERVE_MS: "60000",
      CHANNEX_ARI_DISPATCH_JITTER_MS: "5000",
    } as NodeJS.ProcessEnv),
    {
      pollMs: 300_000,
      selectionLimit: 100,
      candidateScanLimit: 1_000,
      leaseMs: 300_000,
      timeoutMs: 120_000,
      completionReserveMs: 60_000,
      jitterMs: 5_000,
    }
  );
});

test("rejects invalid integer and range values with stable variable-specific errors", () => {
  const scenarios: Array<[string, string, RegExp]> = [
    ["CHANNEX_ARI_DISPATCH_POLL_MS", "999", /CHANNEX_ARI_DISPATCH_POLL_MS_INVALID/],
    ["CHANNEX_ARI_DISPATCH_POLL_MS", "300001", /CHANNEX_ARI_DISPATCH_POLL_MS_INVALID/],
    ["CHANNEX_ARI_DISPATCH_SELECTION_LIMIT", "0", /CHANNEX_ARI_DISPATCH_SELECTION_LIMIT_INVALID/],
    ["CHANNEX_ARI_DISPATCH_SELECTION_LIMIT", "101", /CHANNEX_ARI_DISPATCH_SELECTION_LIMIT_INVALID/],
    ["CHANNEX_ARI_DISPATCH_CANDIDATE_SCAN_LIMIT", "1001", /CHANNEX_ARI_DISPATCH_CANDIDATE_SCAN_LIMIT_INVALID/],
    ["CHANNEX_ARI_DISPATCH_LEASE_MS", "29999", /CHANNEX_ARI_DISPATCH_LEASE_MS_INVALID/],
    ["CHANNEX_ARI_DISPATCH_LEASE_MS", "300001", /CHANNEX_ARI_DISPATCH_LEASE_MS_INVALID/],
    ["CHANNEX_ARI_DISPATCH_HTTP_TIMEOUT_MS", "999", /CHANNEX_ARI_DISPATCH_HTTP_TIMEOUT_MS_INVALID/],
    ["CHANNEX_ARI_DISPATCH_HTTP_TIMEOUT_MS", "120001", /CHANNEX_ARI_DISPATCH_HTTP_TIMEOUT_MS_INVALID/],
    ["CHANNEX_ARI_DISPATCH_COMPLETION_RESERVE_MS", "-1", /CHANNEX_ARI_DISPATCH_COMPLETION_RESERVE_MS_INVALID/],
    ["CHANNEX_ARI_DISPATCH_COMPLETION_RESERVE_MS", "60001", /CHANNEX_ARI_DISPATCH_COMPLETION_RESERVE_MS_INVALID/],
    ["CHANNEX_ARI_DISPATCH_JITTER_MS", "-1", /CHANNEX_ARI_DISPATCH_JITTER_MS_INVALID/],
    ["CHANNEX_ARI_DISPATCH_JITTER_MS", "5001", /CHANNEX_ARI_DISPATCH_JITTER_MS_INVALID/],
    ["CHANNEX_ARI_DISPATCH_POLL_MS", "1.5", /CHANNEX_ARI_DISPATCH_POLL_MS_INVALID/],
    ["CHANNEX_ARI_DISPATCH_POLL_MS", "not-a-number", /CHANNEX_ARI_DISPATCH_POLL_MS_INVALID/],
  ];

  for (const [name, value, error] of scenarios) {
    assert.throws(
      () => resolveChannexAriDispatchConfig({ [name]: value } as NodeJS.ProcessEnv),
      error
    );
  }
});

test("requires candidate scan limit to cover the selection limit", () => {
  assert.throws(
    () =>
      resolveChannexAriDispatchConfig({
        CHANNEX_ARI_DISPATCH_SELECTION_LIMIT: "40",
        CHANNEX_ARI_DISPATCH_CANDIDATE_SCAN_LIMIT: "39",
      } as NodeJS.ProcessEnv),
    /CHANNEX_ARI_DISPATCH_CANDIDATE_SCAN_LIMIT_INVALID/
  );
});

test("requires lease budget to cover HTTP timeout plus completion reserve", () => {
  assert.throws(
    () =>
      resolveChannexAriDispatchConfig({
        CHANNEX_ARI_DISPATCH_LEASE_MS: "30000",
        CHANNEX_ARI_DISPATCH_HTTP_TIMEOUT_MS: "25000",
        CHANNEX_ARI_DISPATCH_COMPLETION_RESERVE_MS: "5001",
      } as NodeJS.ProcessEnv),
    /CHANNEX_ARI_DISPATCH_LEASE_BUDGET_INVALID/
  );

  assert.equal(
    resolveChannexAriDispatchConfig({
      CHANNEX_ARI_DISPATCH_LEASE_MS: "30000",
      CHANNEX_ARI_DISPATCH_HTTP_TIMEOUT_MS: "25000",
      CHANNEX_ARI_DISPATCH_COMPLETION_RESERVE_MS: "5000",
    } as NodeJS.ProcessEnv).leaseMs,
    30_000
  );
});
