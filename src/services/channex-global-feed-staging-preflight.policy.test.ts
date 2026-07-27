import assert from "node:assert/strict";
import test from "node:test";
import { buildChannexGlobalFeedStagingPreflight } from "./channex-global-feed-staging-preflight.policy";

const common = {
  nodeEnv: "staging",
  databaseUrl: "postgresql://user:database-secret@staging-db:5432/pingo",
  channexApiKey: "channex-secret-key",
  pmsCredentialsSecret: "pms-secret",
  channexApiBaseUrl: "https://staging.channex.io",
  channexGlobalFeedEnabled: "false",
  railwayProjectName: "PinGo Staging",
  railwayProjectId: "project-001",
  railwayEnvironmentName: "staging-channex-certification",
  railwayEnvironmentId: "environment-001",
  railwayServiceName: "pin-go-channex-global-feed-staging",
  railwayServiceId: "service-global-feed",
  railwayGitCommitSha: "a".repeat(40),
  railwayGitBranch: "recovery/distribution-engine-v2-channex-lifecycle",
  railwayGitRepoOwner: "freddiefernandezmaysonet-netizen",
  railwayGitRepoName: "pin-go-backend",
};

test("declares a correctly scoped disabled staging service ready", () => {
  const result = buildChannexGlobalFeedStagingPreflight(common);

  assert.equal(result.status, "READY_DISABLED");
  assert.equal(result.safeToCreateServiceDisabled, true);
  assert.equal(result.activation.enabled, false);
  assert.equal(result.networkCallsPerformed, false);
  assert.equal(result.databaseQueriesPerformed, false);
  assert.equal(result.failedChecks.length, 0);
  assert.equal(result.runtimeFingerprint.role, "GLOBAL_FEED_WORKER");
  assert.equal(result.credentialScope.channexBaseUrlHost, "staging.channex.io");
  assert.equal(result.credentialScope.credentialScopeFingerprint?.length, 24);
});

test("never includes raw secrets in serialized output", () => {
  const result = buildChannexGlobalFeedStagingPreflight(common);
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes("database-secret"), false);
  assert.equal(serialized.includes("channex-secret-key"), false);
  assert.equal(serialized.includes("pms-secret"), false);
  assert.equal(serialized.includes(common.databaseUrl), false);
  assert.equal(serialized.includes(common.channexApiKey), false);
  assert.equal(serialized.includes(common.pmsCredentialsSecret), false);
});

test("blocks creation when activation is enabled", () => {
  const result = buildChannexGlobalFeedStagingPreflight({
    ...common,
    channexGlobalFeedEnabled: "true",
  });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.safeToCreateServiceDisabled, false);
  assert.equal(result.activation.enabled, true);
  assert.equal(
    result.failedChecks.some((check) => check.code === "ACTIVATION_DISABLED"),
    true
  );
});

test("blocks missing credentials without revealing values", () => {
  const result = buildChannexGlobalFeedStagingPreflight({
    ...common,
    channexApiKey: null,
    pmsCredentialsSecret: null,
  });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.credentialScope.credentialScopeFingerprint, null);
  assert.equal(
    result.failedChecks.some(
      (check) => check.code === "CHANNEX_API_KEY_CONFIGURED"
    ),
    true
  );
  assert.equal(
    result.failedChecks.some(
      (check) => check.code === "PMS_CREDENTIALS_SECRET_CONFIGURED"
    ),
    true
  );
});

test("blocks non-staging Channex host and non-HTTPS URLs", () => {
  const productionHost = buildChannexGlobalFeedStagingPreflight({
    ...common,
    channexApiBaseUrl: "https://app.channex.io",
  });
  const insecureHost = buildChannexGlobalFeedStagingPreflight({
    ...common,
    channexApiBaseUrl: "http://staging.channex.io",
  });

  assert.equal(productionHost.status, "BLOCKED");
  assert.equal(
    productionHost.failedChecks.some(
      (check) => check.code === "CHANNEX_BASE_URL_STAGING_SCOPE"
    ),
    true
  );
  assert.equal(insecureHost.status, "BLOCKED");
  assert.equal(
    insecureHost.failedChecks.some(
      (check) => check.code === "CHANNEX_BASE_URL_HTTPS"
    ),
    true
  );
});

test("blocks service, environment, branch and repository mismatches", () => {
  const result = buildChannexGlobalFeedStagingPreflight({
    ...common,
    railwayEnvironmentName: "production",
    railwayServiceName: "unexpected-service",
    railwayGitBranch: "main",
    railwayGitRepoOwner: "other-owner",
  });
  const failedCodes = new Set(result.failedChecks.map((check) => check.code));

  assert.equal(result.status, "BLOCKED");
  assert.equal(failedCodes.has("RAILWAY_ENVIRONMENT_MATCH"), true);
  assert.equal(failedCodes.has("RAILWAY_SERVICE_MATCH"), true);
  assert.equal(failedCodes.has("GIT_BRANCH_MATCH"), true);
  assert.equal(failedCodes.has("GIT_REPOSITORY_MATCH"), true);
});

test("defaults absent activation to disabled", () => {
  const result = buildChannexGlobalFeedStagingPreflight({
    ...common,
    channexGlobalFeedEnabled: null,
  });

  assert.equal(result.status, "READY_DISABLED");
  assert.equal(result.activation.enabled, false);
  assert.equal(result.activation.source, "DEFAULT_DISABLED");
});

test("rejects malformed activation and malformed runtime identity", () => {
  assert.throws(
    () =>
      buildChannexGlobalFeedStagingPreflight({
        ...common,
        channexGlobalFeedEnabled: "maybe",
      }),
    /CHANNEX_GLOBAL_FEED_ENABLED_INVALID/
  );

  assert.throws(
    () =>
      buildChannexGlobalFeedStagingPreflight({
        ...common,
        railwayGitCommitSha: "not-a-sha",
      }),
    /RAILWAY_GIT_COMMIT_SHA_INVALID/
  );
});
