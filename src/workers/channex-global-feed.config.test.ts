import assert from "node:assert/strict";
import test from "node:test";
import { resolveChannexGlobalFeedConfig } from "./channex-global-feed.config";

test("global Channex feed config uses safe defaults", () => {
  assert.deepEqual(resolveChannexGlobalFeedConfig({}), {
    pollMs: 60_000,
    leaseMs: 600_000,
    maxSourcesPerRun: 25,
    maxRevisionsPerRun: 500,
  });
});

test("global Channex feed config accepts explicit valid values", () => {
  assert.deepEqual(
    resolveChannexGlobalFeedConfig({
      CHANNEX_GLOBAL_FEED_POLL_MS: "5000",
      CHANNEX_GLOBAL_FEED_LEASE_MS: "60000",
      CHANNEX_GLOBAL_FEED_MAX_SOURCES_PER_RUN: "500",
      CHANNEX_GLOBAL_FEED_MAX_REVISIONS_PER_RUN: "5000",
    }),
    {
      pollMs: 5_000,
      leaseMs: 60_000,
      maxSourcesPerRun: 500,
      maxRevisionsPerRun: 5_000,
    }
  );
});

for (const [name, value] of [
  ["CHANNEX_GLOBAL_FEED_POLL_MS", "4999"],
  ["CHANNEX_GLOBAL_FEED_POLL_MS", "300001"],
  ["CHANNEX_GLOBAL_FEED_POLL_MS", "1.5"],
  ["CHANNEX_GLOBAL_FEED_POLL_MS", "not-a-number"],
  ["CHANNEX_GLOBAL_FEED_LEASE_MS", "59999"],
  ["CHANNEX_GLOBAL_FEED_LEASE_MS", "3600001"],
  ["CHANNEX_GLOBAL_FEED_MAX_SOURCES_PER_RUN", "0"],
  ["CHANNEX_GLOBAL_FEED_MAX_SOURCES_PER_RUN", "501"],
  ["CHANNEX_GLOBAL_FEED_MAX_REVISIONS_PER_RUN", "0"],
  ["CHANNEX_GLOBAL_FEED_MAX_REVISIONS_PER_RUN", "5001"],
] as const) {
  test(`global Channex feed config rejects invalid ${name}=${value}`, () => {
    assert.throws(
      () => resolveChannexGlobalFeedConfig({ [name]: value }),
      new RegExp(`${name}_INVALID`)
    );
  });
}

test("global Channex feed config trims environment values", () => {
  assert.deepEqual(
    resolveChannexGlobalFeedConfig({
      CHANNEX_GLOBAL_FEED_POLL_MS: " 60000 ",
      CHANNEX_GLOBAL_FEED_LEASE_MS: " 600000 ",
      CHANNEX_GLOBAL_FEED_MAX_SOURCES_PER_RUN: " 25 ",
      CHANNEX_GLOBAL_FEED_MAX_REVISIONS_PER_RUN: " 500 ",
    }),
    {
      pollMs: 60_000,
      leaseMs: 600_000,
      maxSourcesPerRun: 25,
      maxRevisionsPerRun: 500,
    }
  );
});
