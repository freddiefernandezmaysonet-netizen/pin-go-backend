import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStagingRuntimeFingerprint,
  compareStagingRuntimeFingerprints,
} from "./staging-runtime-fingerprint.policy";

const common = {
  nodeEnv: "staging",
  databaseUrl: "postgresql://user:secret@staging-db:5432/pingo",
  railwayProjectName: "PinGo Staging",
  railwayProjectId: "project-001",
  railwayEnvironmentName: "staging",
  railwayEnvironmentId: "environment-001",
  railwayGitCommitSha: "a".repeat(40),
  railwayGitBranch: "sprint/distribution-engine-channex-outbound-ari-v1",
  railwayGitRepoOwner: "freddiefernandezmaysonet-netizen",
  railwayGitRepoName: "pin-go-backend",
};

test("API and worker are compatible only with the same commit and database", () => {
  const api = buildStagingRuntimeFingerprint({
    ...common,
    role: "API",
    railwayServiceName: "pin-go-api-staging",
    railwayServiceId: "service-api",
  });
  const worker = buildStagingRuntimeFingerprint({
    ...common,
    role: "RECOVERY_WORKER",
    railwayServiceName: "pin-go-connect-recovery-staging",
    railwayServiceId: "service-worker",
  });

  const comparison = compareStagingRuntimeFingerprints(api, worker);

  assert.equal(comparison.compatible, true);
  assert.equal(comparison.sameCommit, true);
  assert.equal(comparison.sameDatabase, true);
  assert.notEqual(api.runtime.serviceIdentity, worker.runtime.serviceIdentity);
  assert.equal(api.databaseFingerprint.length, 24);
  assert.equal(api.compatibilityKey.length, 24);
  assert.equal(JSON.stringify(api).includes("secret"), false);
});

test("different commit or database fails compatibility", () => {
  const api = buildStagingRuntimeFingerprint({
    ...common,
    role: "API",
    railwayServiceName: "api",
    railwayServiceId: "api-id",
  });
  const worker = buildStagingRuntimeFingerprint({
    ...common,
    role: "RECOVERY_WORKER",
    databaseUrl: "postgresql://user:other@other-db:5432/pingo",
    railwayGitCommitSha: "b".repeat(40),
    railwayServiceName: "worker",
    railwayServiceId: "worker-id",
  });

  const comparison = compareStagingRuntimeFingerprints(api, worker);

  assert.equal(comparison.compatible, false);
  assert.equal(comparison.sameCommit, false);
  assert.equal(comparison.sameDatabase, false);
});

test("fingerprint rejects non-staging and malformed commit identity", () => {
  assert.throws(
    () =>
      buildStagingRuntimeFingerprint({
        ...common,
        role: "API",
        nodeEnv: "production",
        railwayServiceName: "api",
        railwayServiceId: "api-id",
      }),
    /STAGING_RUNTIME_REQUIRES_NODE_ENV_STAGING/
  );

  assert.throws(
    () =>
      buildStagingRuntimeFingerprint({
        ...common,
        role: "API",
        railwayGitCommitSha: "not-a-sha",
        railwayServiceName: "api",
        railwayServiceId: "api-id",
      }),
    /RAILWAY_GIT_COMMIT_SHA_INVALID/
  );
});
