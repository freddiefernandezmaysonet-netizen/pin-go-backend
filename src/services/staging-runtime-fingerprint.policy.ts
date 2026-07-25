import crypto from "node:crypto";

export type StagingRuntimeRole = "API" | "RECOVERY_WORKER";

export type StagingRuntimeFingerprintInput = {
  role: StagingRuntimeRole;
  nodeEnv: string | null;
  databaseUrl: string | null;
  railwayProjectName: string | null;
  railwayProjectId: string | null;
  railwayEnvironmentName: string | null;
  railwayEnvironmentId: string | null;
  railwayServiceName: string | null;
  railwayServiceId: string | null;
  railwayGitCommitSha: string | null;
  railwayGitBranch: string | null;
  railwayGitRepoOwner: string | null;
  railwayGitRepoName: string | null;
};

function required(value: string | null, code: string) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function hash(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function buildStagingRuntimeFingerprint(
  input: StagingRuntimeFingerprintInput
) {
  const nodeEnv = required(input.nodeEnv, "NODE_ENV_REQUIRED").toLowerCase();
  if (nodeEnv !== "staging") {
    throw new Error("STAGING_RUNTIME_REQUIRES_NODE_ENV_STAGING");
  }

  const databaseUrl = required(input.databaseUrl, "DATABASE_URL_REQUIRED");
  const projectName = required(
    input.railwayProjectName,
    "RAILWAY_PROJECT_NAME_REQUIRED"
  );
  const projectId = required(
    input.railwayProjectId,
    "RAILWAY_PROJECT_ID_REQUIRED"
  );
  const environmentName = required(
    input.railwayEnvironmentName,
    "RAILWAY_ENVIRONMENT_NAME_REQUIRED"
  );
  const environmentId = required(
    input.railwayEnvironmentId,
    "RAILWAY_ENVIRONMENT_ID_REQUIRED"
  );
  const serviceName = required(
    input.railwayServiceName,
    "RAILWAY_SERVICE_NAME_REQUIRED"
  );
  const serviceId = required(
    input.railwayServiceId,
    "RAILWAY_SERVICE_ID_REQUIRED"
  );
  const commitSha = required(
    input.railwayGitCommitSha,
    "RAILWAY_GIT_COMMIT_SHA_REQUIRED"
  ).toLowerCase();
  const branch = required(
    input.railwayGitBranch,
    "RAILWAY_GIT_BRANCH_REQUIRED"
  );
  const repoOwner = required(
    input.railwayGitRepoOwner,
    "RAILWAY_GIT_REPO_OWNER_REQUIRED"
  );
  const repoName = required(
    input.railwayGitRepoName,
    "RAILWAY_GIT_REPO_NAME_REQUIRED"
  );

  if (!/^[a-f0-9]{40}$/.test(commitSha)) {
    throw new Error("RAILWAY_GIT_COMMIT_SHA_INVALID");
  }

  const databaseFingerprint = hash(databaseUrl).slice(0, 24);
  const compatibilityKey = hash(
    [projectId, environmentId, commitSha, databaseFingerprint].join(":")
  ).slice(0, 24);

  return {
    provider: "PIN_GO_CONNECT",
    role: input.role,
    runtime: {
      nodeEnv,
      projectName,
      environmentName,
      serviceName,
      serviceIdentity: hash(serviceId).slice(0, 16),
    },
    source: {
      repository: `${repoOwner}/${repoName}`,
      branch,
      commitSha,
    },
    databaseFingerprint,
    compatibilityKey,
  };
}

export function compareStagingRuntimeFingerprints(
  api: ReturnType<typeof buildStagingRuntimeFingerprint>,
  worker: ReturnType<typeof buildStagingRuntimeFingerprint>
) {
  return {
    compatible:
      api.role === "API" &&
      worker.role === "RECOVERY_WORKER" &&
      api.compatibilityKey === worker.compatibilityKey,
    sameCommit: api.source.commitSha === worker.source.commitSha,
    sameDatabase:
      api.databaseFingerprint === worker.databaseFingerprint,
    sameProject:
      api.runtime.projectName === worker.runtime.projectName,
    sameEnvironment:
      api.runtime.environmentName === worker.runtime.environmentName,
  };
}
