import crypto from "node:crypto";
import { resolveChannexGlobalFeedActivation } from "../workers/channex-global-feed.activation";
import { buildStagingRuntimeFingerprint } from "./staging-runtime-fingerprint.policy";

export type ChannexGlobalFeedStagingPreflightInput = {
  nodeEnv: string | null;
  runtimeRole?: string | null;
  databaseUrl: string | null;
  channexApiKey: string | null;
  pmsCredentialsSecret: string | null;
  channexApiBaseUrl: string | null;
  channexGlobalFeedEnabled: string | null;
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
  expectedEnvironmentName?: string;
  expectedServiceName?: string;
  expectedBranch?: string;
  expectedRepository?: string;
  expectedChannexHost?: string;
};

export type ChannexGlobalFeedStagingPreflightCheck = {
  code: string;
  passed: boolean;
  detail: string;
};

const DEFAULT_EXPECTATIONS = {
  environmentName: "staging-channex-certification",
  serviceName: "pin-go-channex-global-feed-staging",
  branch: "recovery/distribution-engine-v2-channex-lifecycle",
  repository: "freddiefernandezmaysonet-netizen/pin-go-backend",
  channexHost: "staging.channex.io",
};

function normalize(value: string | null | undefined) {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function hash(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseHttpsHost(value: string | null) {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

export function buildChannexGlobalFeedStagingPreflight(
  input: ChannexGlobalFeedStagingPreflightInput
) {
  const expectedEnvironmentName =
    input.expectedEnvironmentName ?? DEFAULT_EXPECTATIONS.environmentName;
  const expectedServiceName =
    input.expectedServiceName ?? DEFAULT_EXPECTATIONS.serviceName;
  const expectedBranch = input.expectedBranch ?? DEFAULT_EXPECTATIONS.branch;
  const expectedRepository =
    input.expectedRepository ?? DEFAULT_EXPECTATIONS.repository;
  const expectedChannexHost =
    input.expectedChannexHost ?? DEFAULT_EXPECTATIONS.channexHost;

  const activation = resolveChannexGlobalFeedActivation({
    CHANNEX_GLOBAL_FEED_ENABLED:
      input.channexGlobalFeedEnabled ?? undefined,
  });
  const runtimeFingerprint = buildStagingRuntimeFingerprint({
    role: "GLOBAL_FEED_WORKER",
    nodeEnv: input.nodeEnv,
    databaseUrl: input.databaseUrl,
    railwayProjectName: input.railwayProjectName,
    railwayProjectId: input.railwayProjectId,
    railwayEnvironmentName: input.railwayEnvironmentName,
    railwayEnvironmentId: input.railwayEnvironmentId,
    railwayServiceName: input.railwayServiceName,
    railwayServiceId: input.railwayServiceId,
    railwayGitCommitSha: input.railwayGitCommitSha,
    railwayGitBranch: input.railwayGitBranch,
    railwayGitRepoOwner: input.railwayGitRepoOwner,
    railwayGitRepoName: input.railwayGitRepoName,
  });

  const runtimeRole = normalize(input.runtimeRole);
  const databaseUrl = normalize(input.databaseUrl);
  const channexApiKey = normalize(input.channexApiKey);
  const pmsCredentialsSecret = normalize(input.pmsCredentialsSecret);
  const channexApiBaseUrl = normalize(input.channexApiBaseUrl);
  const channexHost = parseHttpsHost(channexApiBaseUrl);
  const repository = runtimeFingerprint.source.repository;

  const checks: ChannexGlobalFeedStagingPreflightCheck[] = [
    {
      code: "RUNTIME_ROLE_GLOBAL_FEED_WORKER",
      passed: runtimeRole === "GLOBAL_FEED_WORKER",
      detail: runtimeRole ?? "missing",
    },
    {
      code: "ACTIVATION_DISABLED",
      passed: activation.enabled === false,
      detail: activation.source,
    },
    {
      code: "DATABASE_URL_CONFIGURED",
      passed: databaseUrl !== null,
      detail: databaseUrl ? "configured" : "missing",
    },
    {
      code: "CHANNEX_API_KEY_CONFIGURED",
      passed: channexApiKey !== null,
      detail: channexApiKey ? "configured" : "missing",
    },
    {
      code: "PMS_CREDENTIALS_SECRET_CONFIGURED",
      passed: pmsCredentialsSecret !== null,
      detail: pmsCredentialsSecret ? "configured" : "missing",
    },
    {
      code: "CHANNEX_BASE_URL_HTTPS",
      passed: channexHost !== null,
      detail: channexHost ?? "invalid-or-missing",
    },
    {
      code: "CHANNEX_BASE_URL_STAGING_SCOPE",
      passed: channexHost === expectedChannexHost,
      detail: channexHost ?? "missing",
    },
    {
      code: "RAILWAY_ENVIRONMENT_MATCH",
      passed:
        runtimeFingerprint.runtime.environmentName === expectedEnvironmentName,
      detail: runtimeFingerprint.runtime.environmentName,
    },
    {
      code: "RAILWAY_SERVICE_MATCH",
      passed: runtimeFingerprint.runtime.serviceName === expectedServiceName,
      detail: runtimeFingerprint.runtime.serviceName,
    },
    {
      code: "GIT_BRANCH_MATCH",
      passed: runtimeFingerprint.source.branch === expectedBranch,
      detail: runtimeFingerprint.source.branch,
    },
    {
      code: "GIT_REPOSITORY_MATCH",
      passed: repository === expectedRepository,
      detail: repository,
    },
  ];

  const credentialScopeFingerprint =
    channexApiKey && pmsCredentialsSecret && channexApiBaseUrl
      ? hash(
          [channexApiKey, pmsCredentialsSecret, channexApiBaseUrl].join(":")
        ).slice(0, 24)
      : null;
  const failedChecks = checks.filter((check) => !check.passed);

  return {
    provider: "PIN_GO_CONNECT",
    status: failedChecks.length === 0 ? "READY_DISABLED" : "BLOCKED",
    safeToCreateServiceDisabled: failedChecks.length === 0,
    networkCallsPerformed: false,
    databaseQueriesPerformed: false,
    activation,
    runtimeFingerprint,
    credentialScope: {
      databaseConfigured: databaseUrl !== null,
      channexApiKeyConfigured: channexApiKey !== null,
      pmsCredentialsSecretConfigured: pmsCredentialsSecret !== null,
      channexBaseUrlHost: channexHost,
      credentialScopeFingerprint,
    },
    checks,
    failedChecks,
  } as const;
}
