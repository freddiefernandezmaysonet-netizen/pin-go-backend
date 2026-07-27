import "dotenv/config";
import { pathToFileURL } from "node:url";
import { prisma } from "../lib/prisma";
import { runChannexGlobalFeedOnce } from "../pms/ingest/channex-global-feed.service";
import { buildChannexGlobalFeedStagingPreflight } from "../services/channex-global-feed-staging-preflight.policy";
import type { ChannexGlobalFeedConfig } from "../workers/channex-global-feed.config";

const ONE_SHOT_CONFIRMATION = "RUN_CHANNEX_STAGING_GLOBAL_FEED_ONCE";

const ONE_SHOT_CONFIG: ChannexGlobalFeedConfig = {
  pollMs: 300_000,
  leaseMs: 600_000,
  maxSourcesPerRun: 1,
  maxRevisionsPerRun: 1,
};

type OneShotDependencies = {
  runOnce?: typeof runChannexGlobalFeedOnce;
  disconnect?: () => Promise<void>;
  log?: (value: unknown) => void;
  logError?: (value: unknown) => void;
};

function buildPreflight(env: NodeJS.ProcessEnv) {
  return buildChannexGlobalFeedStagingPreflight({
    nodeEnv: env.NODE_ENV ?? null,
    runtimeRole: env.PIN_GO_RUNTIME_ROLE ?? null,
    databaseUrl: env.DATABASE_URL ?? null,
    channexApiKey: env.CHANNEX_API_KEY ?? null,
    pmsCredentialsSecret: env.PMS_CREDENTIALS_SECRET ?? null,
    channexApiBaseUrl: env.CHANNEX_API_BASE_URL ?? null,
    channexGlobalFeedEnabled: env.CHANNEX_GLOBAL_FEED_ENABLED ?? null,
    railwayProjectName: env.RAILWAY_PROJECT_NAME ?? null,
    railwayProjectId: env.RAILWAY_PROJECT_ID ?? null,
    railwayEnvironmentName: env.RAILWAY_ENVIRONMENT_NAME ?? null,
    railwayEnvironmentId: env.RAILWAY_ENVIRONMENT_ID ?? null,
    railwayServiceName: env.RAILWAY_SERVICE_NAME ?? null,
    railwayServiceId: env.RAILWAY_SERVICE_ID ?? null,
    railwayGitCommitSha: env.RAILWAY_GIT_COMMIT_SHA ?? null,
    railwayGitBranch: env.RAILWAY_GIT_BRANCH ?? null,
    railwayGitRepoOwner: env.RAILWAY_GIT_REPO_OWNER ?? null,
    railwayGitRepoName: env.RAILWAY_GIT_REPO_NAME ?? null,
    expectedEnvironmentName:
      env.CHANNEX_GLOBAL_FEED_EXPECTED_ENVIRONMENT ?? undefined,
    expectedServiceName: env.CHANNEX_GLOBAL_FEED_EXPECTED_SERVICE ?? undefined,
    expectedBranch: env.CHANNEX_GLOBAL_FEED_EXPECTED_BRANCH ?? undefined,
    expectedRepository:
      env.CHANNEX_GLOBAL_FEED_EXPECTED_REPOSITORY ?? undefined,
    expectedChannexHost: env.CHANNEX_GLOBAL_FEED_EXPECTED_HOST ?? undefined,
  });
}

function safeErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim();

  if (/^[A-Z0-9_:-]{1,200}$/.test(normalized)) {
    return normalized;
  }

  return "CHANNEX_GLOBAL_FEED_ONE_SHOT_FAILED";
}

function printJson(log: (value: unknown) => void, value: unknown) {
  log(JSON.stringify(value, null, 2));
}

export async function runChannexGlobalFeedStagingOnce(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: OneShotDependencies = {}
) {
  const runOnce = dependencies.runOnce ?? runChannexGlobalFeedOnce;
  const disconnect = dependencies.disconnect ?? (() => prisma.$disconnect());
  const log = dependencies.log ?? console.log;
  const logError = dependencies.logError ?? console.error;

  const preflight = buildPreflight(env);

  if (preflight.status !== "READY_DISABLED") {
    printJson(logError, {
      provider: "PIN_GO_CONNECT",
      executionMode: "STAGING_GLOBAL_FEED_ONE_SHOT",
      status: "BLOCKED",
      reason: "PREFLIGHT_NOT_READY_DISABLED",
      failedChecks: preflight.failedChecks,
      networkCallsPerformed: false,
      databaseQueriesPerformed: false,
    });
    return 1;
  }

  const confirmation = String(
    env.CHANNEX_GLOBAL_FEED_STAGING_ONE_SHOT_CONFIRMATION ?? ""
  ).trim();

  if (confirmation !== ONE_SHOT_CONFIRMATION) {
    printJson(logError, {
      provider: "PIN_GO_CONNECT",
      executionMode: "STAGING_GLOBAL_FEED_ONE_SHOT",
      status: "BLOCKED",
      reason: "ONE_SHOT_CONFIRMATION_REQUIRED",
      expectedConfirmationVariable:
        "CHANNEX_GLOBAL_FEED_STAGING_ONE_SHOT_CONFIRMATION",
      networkCallsPerformed: false,
      databaseQueriesPerformed: false,
    });
    return 1;
  }

  try {
    const result = await runOnce({ config: ONE_SHOT_CONFIG });

    const success =
      result.status === "COMPLETED" &&
      result.credentialSourceCount === 1 &&
      result.selectedRevisionCount <= 1 &&
      result.failedSourceCount === 0 &&
      result.failedRevisionCount === 0;

    printJson(success ? log : logError, {
      provider: "PIN_GO_CONNECT",
      executionMode: "STAGING_GLOBAL_FEED_ONE_SHOT",
      status: success ? "PASS" : "FAILED",
      runStatus: result.status,
      limits: {
        leaseMs: ONE_SHOT_CONFIG.leaseMs,
        maxSourcesPerRun: ONE_SHOT_CONFIG.maxSourcesPerRun,
        maxRevisionsPerRun: ONE_SHOT_CONFIG.maxRevisionsPerRun,
      },
      connectionCount: result.connectionCount,
      credentialSourceCount: result.credentialSourceCount,
      discoveredRevisionCount: result.discoveredRevisionCount,
      selectedRevisionCount: result.selectedRevisionCount,
      truncatedRevisionCount: result.truncatedRevisionCount,
      acknowledgedRevisionCount: result.acknowledgedRevisionCount,
      failedRevisionCount: result.failedRevisionCount,
      failedSourceCount: result.failedSourceCount,
      duplicateRevisionCount: result.duplicateRevisionCount,
      emptyFeed: result.emptyFeed,
      longRunningWorkerActivationChanged: false,
    });

    return success ? 0 : 1;
  } catch (error) {
    printJson(logError, {
      provider: "PIN_GO_CONNECT",
      executionMode: "STAGING_GLOBAL_FEED_ONE_SHOT",
      status: "FAILED",
      errorCode: safeErrorCode(error),
      longRunningWorkerActivationChanged: false,
    });
    return 1;
  } finally {
    await disconnect().catch(() => undefined);
  }
}

function isDirectExecution() {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;

  try {
    return pathToFileURL(entrypoint).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  void runChannexGlobalFeedStagingOnce().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
