import "dotenv/config";
import { buildStagingRuntimeFingerprint } from "../services/staging-runtime-fingerprint.policy";

const role = String(process.env.PIN_GO_RUNTIME_ROLE ?? "")
  .trim()
  .toUpperCase();

if (role !== "API" && role !== "RECOVERY_WORKER") {
  console.error("PIN_GO_RUNTIME_ROLE must be API or RECOVERY_WORKER.");
  process.exit(1);
}

try {
  const fingerprint = buildStagingRuntimeFingerprint({
    role,
    nodeEnv: process.env.NODE_ENV ?? null,
    databaseUrl: process.env.DATABASE_URL ?? null,
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
  });

  console.log(JSON.stringify(fingerprint, null, 2));
} catch (error) {
  console.error(
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
}
