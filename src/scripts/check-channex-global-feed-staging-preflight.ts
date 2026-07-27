import "dotenv/config";
import { buildChannexGlobalFeedStagingPreflight } from "../services/channex-global-feed-staging-preflight.policy";

try {
  const report = buildChannexGlobalFeedStagingPreflight({
    nodeEnv: process.env.NODE_ENV ?? null,
    databaseUrl: process.env.DATABASE_URL ?? null,
    channexApiKey: process.env.CHANNEX_API_KEY ?? null,
    pmsCredentialsSecret: process.env.PMS_CREDENTIALS_SECRET ?? null,
    channexApiBaseUrl: process.env.CHANNEX_API_BASE_URL ?? null,
    channexGlobalFeedEnabled:
      process.env.CHANNEX_GLOBAL_FEED_ENABLED ?? null,
    railwayProjectName: process.env.RAILWAY_PROJECT_NAME ?? null,
    railwayProjectId: process.env.RAILWAY_PROJECT_ID ?? null,
    railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME ?? null,
    railwayEnvironmentId: process.env.RAILWAY_ENVIRONMENT_ID ?? null,
    railwayServiceName: process.env.RAILWAY_SERVICE_NAME ?? null,
    railwayServiceId: process.env.RAILWAY_SERVICE_ID ?? null,
    railwayGitCommitSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
    railwayGitBranch: process.env.RAILWAY_GIT_BRANCH ?? null,
    railwayGitRepoOwner: process.env.RAILWAY_GIT_REPO_OWNER ?? null,
    railwayGitRepoName: process.env.RAILWAY_GIT_REPO_NAME ?? null,
    expectedEnvironmentName:
      process.env.CHANNEX_GLOBAL_FEED_EXPECTED_ENVIRONMENT ?? undefined,
    expectedServiceName:
      process.env.CHANNEX_GLOBAL_FEED_EXPECTED_SERVICE ?? undefined,
    expectedBranch:
      process.env.CHANNEX_GLOBAL_FEED_EXPECTED_BRANCH ?? undefined,
    expectedRepository:
      process.env.CHANNEX_GLOBAL_FEED_EXPECTED_REPOSITORY ?? undefined,
    expectedChannexHost:
      process.env.CHANNEX_GLOBAL_FEED_EXPECTED_HOST ?? undefined,
  });

  console.log(JSON.stringify(report, null, 2));

  if (report.status !== "READY_DISABLED") {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify(
      {
        provider: "PIN_GO_CONNECT",
        status: "BLOCKED",
        safeToCreateServiceDisabled: false,
        networkCallsPerformed: false,
        databaseQueriesPerformed: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}
