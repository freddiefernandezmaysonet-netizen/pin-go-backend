import assert from "node:assert/strict";
import test from "node:test";
import type { ChannexGlobalFeedExecutionResult } from "../pms/ingest/channex-global-feed.service";
import type { ChannexGlobalFeedConfig } from "../workers/channex-global-feed.config";
import { runChannexGlobalFeedStagingOnce } from "./run-channex-global-feed-staging-once";

const VALID_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "staging",
  PIN_GO_RUNTIME_ROLE: "GLOBAL_FEED_WORKER",
  DATABASE_URL: "postgresql://user:database-secret@staging-db:5432/pingo",
  CHANNEX_API_KEY: "channex-secret-key",
  PMS_CREDENTIALS_SECRET: "pms-secret",
  CHANNEX_API_BASE_URL: "https://staging.channex.io",
  CHANNEX_GLOBAL_FEED_ENABLED: "false",
  CHANNEX_GLOBAL_FEED_STAGING_ONE_SHOT_CONFIRMATION:
    "RUN_CHANNEX_STAGING_GLOBAL_FEED_ONCE",
  RAILWAY_PROJECT_NAME: "PinGo Staging",
  RAILWAY_PROJECT_ID: "project-001",
  RAILWAY_ENVIRONMENT_NAME: "staging-channex-certification",
  RAILWAY_ENVIRONMENT_ID: "environment-001",
  RAILWAY_SERVICE_NAME: "pin-go-channex-global-feed-staging",
  RAILWAY_SERVICE_ID: "service-global-feed",
  RAILWAY_GIT_COMMIT_SHA: "a".repeat(40),
  RAILWAY_GIT_BRANCH: "sprint/distribution-engine-channex-outbound-ari-v1",
  RAILWAY_GIT_REPO_OWNER: "freddiefernandezmaysonet-netizen",
  RAILWAY_GIT_REPO_NAME: "pin-go-backend",
};

function completedResult(
  overrides: Partial<ChannexGlobalFeedExecutionResult> = {}
): ChannexGlobalFeedExecutionResult {
  return {
    status: "COMPLETED",
    sourceCount: 1,
    fetchedSourceCount: 1,
    failedSourceCount: 0,
    fetchedRevisionCount: 1,
    acknowledgedRevisionCount: 1,
    failedRevisionCount: 0,
    duplicateRevisionCount: 0,
    emptyFeed: false,
    sourceErrors: [],
    revisions: [
      {
        sourceId: "source-001",
        revisionId: "revision-001",
        propertyId: "property-001",
        insertedAt: "2026-07-27T12:00:00.000Z",
        outcome: "ACKNOWLEDGED",
        target: {
          organizationId: "organization-001",
          propertyId: "property-001",
          connectionId: "connection-001",
        },
      },
    ],
    connectionCount: 1,
    credentialSourceCount: 1,
    discoveredRevisionCount: 1,
    selectedRevisionCount: 1,
    truncatedRevisionCount: 0,
    ...overrides,
  };
}

function parseJsonLog(entries: unknown[]) {
  assert.equal(entries.length, 1);
  assert.equal(typeof entries[0], "string");
  return JSON.parse(entries[0] as string) as Record<string, any>;
}

test("blocks before execution when the staging preflight is not ready", async () => {
  let runCount = 0;
  let disconnectCount = 0;
  const errors: unknown[] = [];

  const exitCode = await runChannexGlobalFeedStagingOnce(
    {
      ...VALID_ENV,
      PIN_GO_RUNTIME_ROLE: "API",
    },
    {
      runOnce: async () => {
        runCount += 1;
        return completedResult();
      },
      disconnect: async () => {
        disconnectCount += 1;
      },
      log: () => undefined,
      logError: (value) => errors.push(value),
    }
  );

  assert.equal(exitCode, 1);
  assert.equal(runCount, 0);
  assert.equal(disconnectCount, 0);

  const output = parseJsonLog(errors);
  assert.equal(output.status, "BLOCKED");
  assert.equal(output.reason, "PREFLIGHT_NOT_READY_DISABLED");
  assert.equal(output.networkCallsPerformed, false);
  assert.equal(output.databaseQueriesPerformed, false);
});

test("blocks before execution when explicit one-shot confirmation is absent", async () => {
  let runCount = 0;
  const errors: unknown[] = [];

  const exitCode = await runChannexGlobalFeedStagingOnce(
    {
      ...VALID_ENV,
      CHANNEX_GLOBAL_FEED_STAGING_ONE_SHOT_CONFIRMATION: "",
    },
    {
      runOnce: async () => {
        runCount += 1;
        return completedResult();
      },
      disconnect: async () => undefined,
      log: () => undefined,
      logError: (value) => errors.push(value),
    }
  );

  assert.equal(exitCode, 1);
  assert.equal(runCount, 0);

  const output = parseJsonLog(errors);
  assert.equal(output.status, "BLOCKED");
  assert.equal(output.reason, "ONE_SHOT_CONFIRMATION_REQUIRED");
  assert.equal(output.networkCallsPerformed, false);
  assert.equal(output.databaseQueriesPerformed, false);
});

test("executes exactly once with fixed one-source and one-revision limits", async () => {
  let runCount = 0;
  let disconnectCount = 0;
  let receivedConfig: ChannexGlobalFeedConfig | undefined;
  const logs: unknown[] = [];
  const errors: unknown[] = [];

  const exitCode = await runChannexGlobalFeedStagingOnce(VALID_ENV, {
    runOnce: async (args) => {
      runCount += 1;
      receivedConfig = args?.config;
      return completedResult();
    },
    disconnect: async () => {
      disconnectCount += 1;
    },
    log: (value) => logs.push(value),
    logError: (value) => errors.push(value),
  });

  assert.equal(exitCode, 0);
  assert.equal(runCount, 1);
  assert.equal(disconnectCount, 1);
  assert.deepEqual(receivedConfig, {
    pollMs: 300_000,
    leaseMs: 600_000,
    maxSourcesPerRun: 1,
    maxRevisionsPerRun: 1,
  });
  assert.equal(errors.length, 0);

  const output = parseJsonLog(logs);
  assert.equal(output.status, "PASS");
  assert.equal(output.credentialSourceCount, 1);
  assert.equal(output.selectedRevisionCount, 1);
  assert.equal(output.acknowledgedRevisionCount, 1);
  assert.equal(output.longRunningWorkerActivationChanged, false);

  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes("database-secret"), false);
  assert.equal(serialized.includes("channex-secret-key"), false);
  assert.equal(serialized.includes("pms-secret"), false);
});

test("does not certify an empty Feed as a successful controlled run", async () => {
  const errors: unknown[] = [];

  const exitCode = await runChannexGlobalFeedStagingOnce(VALID_ENV, {
    runOnce: async () =>
      completedResult({
        fetchedRevisionCount: 0,
        acknowledgedRevisionCount: 0,
        emptyFeed: true,
        revisions: [],
        discoveredRevisionCount: 0,
        selectedRevisionCount: 0,
      }),
    disconnect: async () => undefined,
    log: () => undefined,
    logError: (value) => errors.push(value),
  });

  assert.equal(exitCode, 1);
  const output = parseJsonLog(errors);
  assert.equal(output.status, "FAILED");
  assert.equal(output.emptyFeed, true);
  assert.equal(output.selectedRevisionCount, 0);
  assert.equal(output.acknowledgedRevisionCount, 0);
});

test("does not certify a selected revision without exactly one ACK", async () => {
  const errors: unknown[] = [];

  const exitCode = await runChannexGlobalFeedStagingOnce(VALID_ENV, {
    runOnce: async () =>
      completedResult({
        acknowledgedRevisionCount: 0,
        duplicateRevisionCount: 1,
        revisions: [
          {
            sourceId: "source-001",
            revisionId: "revision-001",
            propertyId: "property-001",
            insertedAt: "2026-07-27T12:00:00.000Z",
            outcome: "DUPLICATE_SKIPPED",
          },
        ],
      }),
    disconnect: async () => undefined,
    log: () => undefined,
    logError: (value) => errors.push(value),
  });

  assert.equal(exitCode, 1);
  const output = parseJsonLog(errors);
  assert.equal(output.status, "FAILED");
  assert.equal(output.selectedRevisionCount, 1);
  assert.equal(output.acknowledgedRevisionCount, 0);
  assert.equal(output.duplicateRevisionCount, 1);
});

test("sanitizes unexpected execution errors and always disconnects", async () => {
  let disconnectCount = 0;
  const errors: unknown[] = [];

  const exitCode = await runChannexGlobalFeedStagingOnce(VALID_ENV, {
    runOnce: async () => {
      throw new Error("request failed with channex-secret-key");
    },
    disconnect: async () => {
      disconnectCount += 1;
    },
    log: () => undefined,
    logError: (value) => errors.push(value),
  });

  assert.equal(exitCode, 1);
  assert.equal(disconnectCount, 1);

  const output = parseJsonLog(errors);
  assert.equal(output.status, "FAILED");
  assert.equal(output.errorCode, "CHANNEX_GLOBAL_FEED_ONE_SHOT_FAILED");
  assert.equal(JSON.stringify(output).includes("channex-secret-key"), false);
});
