import {
  ApmsRuntimePreflightStatus,
  ApmsRuntimeStatus,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";

import {
  reopenOperationalIssue,
  upsertOperationalIssue,
} from "../apms/operational-intelligence.service";
import {
  GUEST_JOURNEY_ACTIVATION_PROFILES,
  resolveGuestJourneyActivationControlPlaneConfig,
  type GuestJourneyActivationControlPlaneConfig,
  type GuestJourneyActivationProfile,
} from "./guest-journey-activation-control-plane.service";
import {
  verifyGuestJourneyRuntimeScope,
  type GuestJourneyRuntimeScopePreflight,
} from "./guest-journey-runtime-enforcement.service";

export const GUEST_JOURNEY_RUNTIME_TRUTH_VERSION =
  "guest_journey_runtime_truth_v1" as const;
export const GUEST_JOURNEY_RUNTIME_NAME =
  "GUEST_JOURNEY" as const;
export const GUEST_JOURNEY_RUNTIME_SERVICE_NAME =
  "reservation-worker" as const;
export const GUEST_JOURNEY_RUNTIME_STALE_AFTER_MS = 60_000;

const RUNTIME_ISSUE_CODE = "GUEST_JOURNEY_RUNTIME_BLOCKED";
const GUEST_JOURNEY_ENV_PREFIX = "GUEST_JOURNEY_";

export type GuestJourneyRuntimeIdentity = {
  runtimeKey: string;
  runtimeName: typeof GUEST_JOURNEY_RUNTIME_NAME;
  environment: string;
  serviceName: string;
  instanceId: string;
  bootId: string;
  deploymentSha: string | null;
  deploymentId: string | null;
};

export type GuestJourneyRuntimeConfigurationSnapshot = {
  controlPlaneVersion: string | null;
  activationProfile: GuestJourneyActivationProfile | null;
  enabledStages: string[];
  configFingerprint: string;
  scopeFingerprint: string;
  organizationScopeHashes: string[];
  propertyScopeHashes: string[];
  organizationScopeCount: number;
  propertyScopeCount: number;
};

export type GuestJourneyRuntimeSafeError = {
  code: string;
  message: string;
  runtimeStatus:
    | typeof ApmsRuntimeStatus.BLOCKED
    | typeof ApmsRuntimeStatus.ERROR;
};

export type GuestJourneyRuntimeContext = {
  identity: GuestJourneyRuntimeIdentity;
  snapshot: GuestJourneyRuntimeConfigurationSnapshot;
  stateId: string | null;
  stateSynchronized: boolean;
  config: GuestJourneyActivationControlPlaneConfig;
  configurationValid: boolean;
  configurationError: GuestJourneyRuntimeSafeError | null;
};

export type GuestJourneyRuntimeTickResult = {
  allowed: boolean;
  statePersisted: boolean;
  status: ApmsRuntimeStatus;
  preflightStatus: ApmsRuntimePreflightStatus;
  preflight: GuestJourneyRuntimeScopePreflight | null;
  error: GuestJourneyRuntimeSafeError | null;
};

type PersistFailureIssue = (
  prisma: PrismaClient,
  context: GuestJourneyRuntimeContext,
  error: GuestJourneyRuntimeSafeError,
  now: Date
) => Promise<unknown>;

type ResolveFailureIssue = (
  prisma: PrismaClient,
  context: GuestJourneyRuntimeContext,
  now: Date
) => Promise<unknown>;

type RuntimeInitializationDependencies = {
  resolveConfig: typeof resolveGuestJourneyActivationControlPlaneConfig;
  persistFailureIssue: PersistFailureIssue;
};

type RuntimeTickDependencies = {
  verifyScope: typeof verifyGuestJourneyRuntimeScope;
  persistFailureIssue: PersistFailureIssue;
  resolveFailureIssue: ResolveFailureIssue;
};

function normalizeText(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function optionalText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function uniqueSorted(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))
  ).sort();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

export function hashGuestJourneyRuntimeScopeId(
  kind: "organization" | "property",
  id: string
): string {
  return sha256({ kind, id: String(id ?? "").trim() });
}

function parseIdentifierList(rawValue: string | undefined): string[] {
  return uniqueSorted(String(rawValue ?? "").split(","));
}

function collectUnresolvedScope(env: NodeJS.ProcessEnv) {
  const organizationIds: string[] = [];
  const propertyIds: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(GUEST_JOURNEY_ENV_PREFIX) && key.endsWith("_ORGANIZATION_IDS")) {
      organizationIds.push(...parseIdentifierList(value));
    }
    if (key.startsWith(GUEST_JOURNEY_ENV_PREFIX) && key.endsWith("_PROPERTY_IDS")) {
      propertyIds.push(...parseIdentifierList(value));
    }
  }

  return {
    organizationIds: uniqueSorted(organizationIds),
    propertyIds: uniqueSorted(propertyIds),
  };
}

function getDeclaredProfile(env: NodeJS.ProcessEnv): GuestJourneyActivationProfile | null {
  const profile = String(env.GUEST_JOURNEY_APMS_ACTIVATION_PROFILE ?? "")
    .trim()
    .toLowerCase();
  if (!profile) return "off";
  return GUEST_JOURNEY_ACTIVATION_PROFILES.includes(
    profile as GuestJourneyActivationProfile
  )
    ? (profile as GuestJourneyActivationProfile)
    : null;
}

function buildScopeSnapshot(input: {
  organizationIds: readonly string[];
  propertyIds: readonly string[];
}) {
  const organizationIds = uniqueSorted(input.organizationIds);
  const propertyIds = uniqueSorted(input.propertyIds);
  return {
    scopeFingerprint: sha256({ organizationIds, propertyIds }),
    organizationScopeHashes: organizationIds.map((id) =>
      hashGuestJourneyRuntimeScopeId("organization", id)
    ),
    propertyScopeHashes: propertyIds.map((id) =>
      hashGuestJourneyRuntimeScopeId("property", id)
    ),
    organizationScopeCount: organizationIds.length,
    propertyScopeCount: propertyIds.length,
  };
}

export function buildGuestJourneyRuntimeIdentity(
  env: NodeJS.ProcessEnv = process.env,
  bootId: string = randomUUID()
): GuestJourneyRuntimeIdentity {
  const environment = normalizeText(
    env.RAILWAY_ENVIRONMENT_NAME ?? env.NODE_ENV,
    "development"
  );
  const serviceName = normalizeText(
    env.RAILWAY_SERVICE_NAME,
    GUEST_JOURNEY_RUNTIME_SERVICE_NAME
  );
  const instanceId = normalizeText(
    env.RAILWAY_REPLICA_ID ?? env.HOSTNAME,
    `instance-${bootId.slice(0, 12)}`
  );
  return {
    runtimeKey: [GUEST_JOURNEY_RUNTIME_NAME, environment, serviceName, bootId].join(":"),
    runtimeName: GUEST_JOURNEY_RUNTIME_NAME,
    environment,
    serviceName,
    instanceId,
    bootId,
    deploymentSha: optionalText(
      env.RAILWAY_GIT_COMMIT_SHA ?? env.GIT_COMMIT_SHA ?? env.COMMIT_SHA
    ),
    deploymentId: optionalText(env.RAILWAY_DEPLOYMENT_ID),
  };
}

export function buildUnresolvedGuestJourneyRuntimeSnapshot(
  env: NodeJS.ProcessEnv = process.env
): GuestJourneyRuntimeConfigurationSnapshot {
  const scope = collectUnresolvedScope(env);
  const guestJourneyEnvironment = Object.fromEntries(
    Object.entries(env)
      .filter(([key]) => key.startsWith(GUEST_JOURNEY_ENV_PREFIX))
      .sort(([left], [right]) => left.localeCompare(right))
  );
  return {
    controlPlaneVersion: null,
    activationProfile: getDeclaredProfile(env),
    enabledStages: [],
    configFingerprint: sha256({ environment: guestJourneyEnvironment }),
    ...buildScopeSnapshot(scope),
  };
}

function sanitizeStageConfig(config: Record<string, unknown>) {
  const { organizationIds: _organizations, propertyIds: _properties, ...safe } = config;
  return safe;
}

export function buildResolvedGuestJourneyRuntimeSnapshot(
  config: GuestJourneyActivationControlPlaneConfig
): GuestJourneyRuntimeConfigurationSnapshot {
  const stageSettings = Object.fromEntries(
    Object.entries(config.configs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([stage, stageConfig]) => [
        stage,
        sanitizeStageConfig(stageConfig as unknown as Record<string, unknown>),
      ])
  );
  return {
    controlPlaneVersion: config.version,
    activationProfile: config.profile,
    enabledStages: uniqueSorted(config.enabledStages),
    configFingerprint: sha256({
      version: config.version,
      profile: config.profile,
      enabledStages: uniqueSorted(config.enabledStages),
      scope: config.scope,
      stageSettings,
    }),
    ...buildScopeSnapshot(config.scope),
  };
}

function safeErrorCode(error: unknown): string {
  const structured =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : null;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const source = structured ?? message.split(":", 1)[0];
  return (
    source.trim().replace(/[^A-Z0-9_]/gi, "_").toUpperCase().slice(0, 120) ||
    "GUEST_JOURNEY_RUNTIME_ERROR"
  );
}

export function sanitizeGuestJourneyRuntimeError(
  error: unknown
): GuestJourneyRuntimeSafeError {
  const code = safeErrorCode(error);
  const scopeFailure = /SCOPE|ORGANIZATION|PROPERTY|TENANT/.test(code);
  return {
    code,
    message: scopeFailure
      ? "The configured Guest Journey tenant/property scope could not be verified."
      : "The Guest Journey activation configuration could not be validated.",
    runtimeStatus: scopeFailure
      ? ApmsRuntimeStatus.BLOCKED
      : ApmsRuntimeStatus.ERROR,
  };
}

function toJsonArray(values: readonly string[]): Prisma.InputJsonValue {
  return [...values] as Prisma.InputJsonValue;
}

async function createRuntimeStateRow(
  prisma: PrismaClient,
  identity: GuestJourneyRuntimeIdentity,
  snapshot: GuestJourneyRuntimeConfigurationSnapshot,
  now: Date
) {
  return prisma.apmsRuntimeState.create({
    data: {
      ...identity,
      controlPlaneVersion: snapshot.controlPlaneVersion,
      activationProfile: snapshot.activationProfile,
      enabledStages: toJsonArray(snapshot.enabledStages),
      configFingerprint: snapshot.configFingerprint,
      scopeFingerprint: snapshot.scopeFingerprint,
      organizationScopeHashes: toJsonArray(snapshot.organizationScopeHashes),
      propertyScopeHashes: toJsonArray(snapshot.propertyScopeHashes),
      organizationScopeCount: snapshot.organizationScopeCount,
      propertyScopeCount: snapshot.propertyScopeCount,
      status: ApmsRuntimeStatus.STARTING,
      preflightStatus: ApmsRuntimePreflightStatus.PENDING,
      startedAt: now,
      lastHeartbeatAt: now,
    },
  });
}

async function applyRuntimeSnapshot(
  prisma: PrismaClient,
  stateId: string,
  snapshot: GuestJourneyRuntimeConfigurationSnapshot
) {
  return prisma.apmsRuntimeState.update({
    where: { id: stateId },
    data: {
      controlPlaneVersion: snapshot.controlPlaneVersion,
      activationProfile: snapshot.activationProfile,
      enabledStages: toJsonArray(snapshot.enabledStages),
      configFingerprint: snapshot.configFingerprint,
      scopeFingerprint: snapshot.scopeFingerprint,
      organizationScopeHashes: toJsonArray(snapshot.organizationScopeHashes),
      propertyScopeHashes: toJsonArray(snapshot.propertyScopeHashes),
      organizationScopeCount: snapshot.organizationScopeCount,
      propertyScopeCount: snapshot.propertyScopeCount,
    },
  });
}

function runtimeIssueOperationalKey(identity: GuestJourneyRuntimeIdentity) {
  return ["APMS_RUNTIME", identity.runtimeName, identity.environment, identity.serviceName].join(":");
}

async function persistRuntimeFailureIssue(
  prisma: PrismaClient,
  context: GuestJourneyRuntimeContext,
  error: GuestJourneyRuntimeSafeError,
  now: Date
) {
  const operationalKey = runtimeIssueOperationalKey(context.identity);
  const existing = await prisma.operationalIssue.findUnique({
    where: { operationalKey },
    select: { id: true, workflowState: true },
  });
  const metadata = {
    runtimeTruthVersion: GUEST_JOURNEY_RUNTIME_TRUTH_VERSION,
    runtimeStatus: error.runtimeStatus,
    errorCode: error.code,
    environment: context.identity.environment,
    serviceName: context.identity.serviceName,
    deploymentSha: context.identity.deploymentSha,
  };

  const issue = existing?.workflowState === "RESOLVED"
    ? await reopenOperationalIssue(prisma, {
        operationalKey,
        workflowState: "ACTION_REQUIRED",
        severity: "CRITICAL",
        responsibleActor: "SYSTEM",
        actionRequired: true,
        recommendedAction:
          "Review the APMS runtime configuration and preflight evidence before rearming this profile.",
        nextAutomaticStep: null,
        canAutoResolve: false,
        autoResolveStatus: "NOT_SUPPORTED",
        autoResolveActionCode: null,
        reopenCode: "GUEST_JOURNEY_RUNTIME_FAILURE_REOPENED",
        reopenSummary: "The Guest Journey runtime became blocked again.",
        reopenedBy: "SYSTEM",
        sourceType: "WORKER",
        occurredAt: now,
        metadata,
      })
    : await upsertOperationalIssue(prisma, {
        operationalKey,
        issueCode: RUNTIME_ISSUE_CODE,
        title: "Guest Journey runtime is blocked",
        issue:
          "Pin&Go blocked the enterprise Guest Journey stages because the runtime configuration or scope preflight is not coherent.",
        operationalImpact:
          "Enterprise Guest Journey stages remain fail-closed while legacy reservation workflows continue.",
        recommendedAction:
          "Review the APMS runtime configuration and preflight evidence before rearming this profile.",
        nextAutomaticStep: null,
        engine: "GUEST_JOURNEY",
        severity: "CRITICAL",
        workflowState: "ACTION_REQUIRED",
        visibility: "DEVELOPER",
        responsibleActor: "SYSTEM",
        actionRequired: true,
        canAutoResolve: false,
        autoResolveStatus: "NOT_SUPPORTED",
        autoResolveActionCode: null,
        sourceType: "WORKER",
        firstDetectedAt: now,
        lastSignalAt: now,
        resolvedAt: null,
        resolutionCode: null,
        resolutionSummary: null,
        resolutionType: null,
        resolvedBy: null,
        actionTarget: "SYSTEM",
        transitionedBy: "SYSTEM",
        transitionCode: "GUEST_JOURNEY_RUNTIME_FAILURE_DETECTED",
        transitionSummary:
          "The Guest Journey runtime failed closed before enterprise stages executed.",
        occurredAt: now,
        metadata,
      });

  if (context.stateId) {
    await prisma.apmsRuntimeState.update({
      where: { id: context.stateId },
      data: { operationalIssueId: issue.id },
    });
  }
  return issue;
}

async function resolveRuntimeFailureIssue(
  prisma: PrismaClient,
  context: GuestJourneyRuntimeContext,
  now: Date
) {
  const operationalKey = runtimeIssueOperationalKey(context.identity);
  const existing = await prisma.operationalIssue.findUnique({
    where: { operationalKey },
    select: { id: true, workflowState: true },
  });
  if (!existing || existing.workflowState === "RESOLVED") return existing;

  const issue = await upsertOperationalIssue(prisma, {
    operationalKey,
    issueCode: RUNTIME_ISSUE_CODE,
    title: "Guest Journey runtime recovered",
    issue: "Pin&Go restored a coherent Guest Journey runtime configuration and preflight.",
    operationalImpact:
      "The runtime may execute only the stages authorized by its current activation profile.",
    recommendedAction: null,
    nextAutomaticStep: null,
    engine: "GUEST_JOURNEY",
    severity: "INFO",
    workflowState: "RESOLVED",
    visibility: "DEVELOPER",
    responsibleActor: "NONE",
    actionRequired: false,
    canAutoResolve: true,
    autoResolveStatus: "SUCCEEDED",
    autoResolveActionCode: null,
    sourceType: "WORKER",
    firstDetectedAt: now,
    lastSignalAt: now,
    resolvedAt: now,
    resolutionCode: "GUEST_JOURNEY_RUNTIME_RECOVERED",
    resolutionSummary:
      "The Guest Journey runtime configuration and scope preflight are coherent.",
    resolutionType: "AUTOMATIC",
    resolvedBy: "SYSTEM",
    actionTarget: "SYSTEM",
    transitionedBy: "SYSTEM",
    transitionCode: "GUEST_JOURNEY_RUNTIME_RECOVERED",
    transitionSummary: "The Guest Journey runtime returned to a safe current state.",
    occurredAt: now,
    metadata: {
      runtimeTruthVersion: GUEST_JOURNEY_RUNTIME_TRUTH_VERSION,
      environment: context.identity.environment,
      serviceName: context.identity.serviceName,
    },
  });

  if (context.stateId) {
    await prisma.apmsRuntimeState.update({
      where: { id: context.stateId },
      data: { operationalIssueId: issue.id },
    });
  }
  return issue;
}

const DEFAULT_INITIALIZATION_DEPENDENCIES: RuntimeInitializationDependencies = {
  resolveConfig: resolveGuestJourneyActivationControlPlaneConfig,
  persistFailureIssue: persistRuntimeFailureIssue,
};

const DEFAULT_TICK_DEPENDENCIES: RuntimeTickDependencies = {
  verifyScope: verifyGuestJourneyRuntimeScope,
  persistFailureIssue: persistRuntimeFailureIssue,
  resolveFailureIssue: resolveRuntimeFailureIssue,
};

async function ensureRuntimeStateRow(
  prisma: PrismaClient,
  context: GuestJourneyRuntimeContext,
  now: Date
) {
  if (context.stateId) return true;
  try {
    const row = await createRuntimeStateRow(prisma, context.identity, context.snapshot, now);
    context.stateId = row.id;
    context.stateSynchronized = true;
    return true;
  } catch {
    return false;
  }
}

async function ensureRuntimeSnapshotPersisted(
  prisma: PrismaClient,
  context: GuestJourneyRuntimeContext
) {
  if (!context.stateId) return false;
  if (context.stateSynchronized) return true;
  try {
    await applyRuntimeSnapshot(prisma, context.stateId, context.snapshot);
    context.stateSynchronized = true;
    return true;
  } catch {
    return false;
  }
}

async function persistRuntimeErrorState(
  prisma: PrismaClient,
  context: GuestJourneyRuntimeContext,
  error: GuestJourneyRuntimeSafeError,
  now: Date,
  persistIssue: PersistFailureIssue
) {
  if (!context.stateId) return false;
  await prisma.apmsRuntimeState.update({
    where: { id: context.stateId },
    data: {
      status: error.runtimeStatus,
      preflightStatus: ApmsRuntimePreflightStatus.FAILED,
      lastPreflightAt: now,
      lastPreflightErrorCode: error.code,
      lastPreflightErrorMessage: error.message,
      lastHeartbeatAt: now,
    },
  });
  await persistIssue(prisma, context, error, now);
  return true;
}

export async function initializeGuestJourneyRuntimeState(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    now?: Date;
    bootId?: string;
    dependencies?: Partial<RuntimeInitializationDependencies>;
  } = {}
): Promise<GuestJourneyRuntimeContext> {
  const now = options.now ?? new Date();
  const dependencies = {
    ...DEFAULT_INITIALIZATION_DEPENDENCIES,
    ...options.dependencies,
  };
  const context: GuestJourneyRuntimeContext = {
    identity: buildGuestJourneyRuntimeIdentity(env, options.bootId ?? randomUUID()),
    snapshot: buildUnresolvedGuestJourneyRuntimeSnapshot(env),
    stateId: null,
    stateSynchronized: false,
    config: resolveGuestJourneyActivationControlPlaneConfig({}),
    configurationValid: false,
    configurationError: null,
  };

  await ensureRuntimeStateRow(prisma, context, now);

  try {
    context.config = dependencies.resolveConfig(env);
    context.snapshot = buildResolvedGuestJourneyRuntimeSnapshot(context.config);
    context.configurationValid = true;
    context.configurationError = null;
  } catch (error) {
    const safeError = sanitizeGuestJourneyRuntimeError(error);
    context.configurationError = safeError;
    if (context.stateId) {
      await persistRuntimeErrorState(
        prisma,
        context,
        safeError,
        now,
        dependencies.persistFailureIssue
      ).catch(() => false);
    } else {
      await dependencies.persistFailureIssue(prisma, context, safeError, now).catch(
        () => null
      );
    }
  }

  if (context.configurationValid && context.stateId) {
    try {
      await applyRuntimeSnapshot(prisma, context.stateId, context.snapshot);
      context.stateSynchronized = true;
    } catch {
      context.stateSynchronized = false;
    }
  }

  return context;
}

export async function evaluateGuestJourneyRuntimeTick(
  prisma: PrismaClient,
  context: GuestJourneyRuntimeContext,
  options: {
    now?: Date;
    dependencies?: Partial<RuntimeTickDependencies>;
  } = {}
): Promise<GuestJourneyRuntimeTickResult> {
  const now = options.now ?? new Date();
  const dependencies = { ...DEFAULT_TICK_DEPENDENCIES, ...options.dependencies };
  const statePersisted = await ensureRuntimeStateRow(prisma, context, now);
  const snapshotPersisted = statePersisted
    ? await ensureRuntimeSnapshotPersisted(prisma, context)
    : false;

  if (!context.configurationValid) {
    const error =
      context.configurationError ??
      sanitizeGuestJourneyRuntimeError("GUEST_JOURNEY_RUNTIME_CONFIGURATION_INVALID");
    if (statePersisted) {
      await persistRuntimeErrorState(
        prisma,
        context,
        error,
        now,
        dependencies.persistFailureIssue
      ).catch(() => false);
    }
    return {
      allowed: false,
      statePersisted,
      status: error.runtimeStatus,
      preflightStatus: ApmsRuntimePreflightStatus.FAILED,
      preflight: null,
      error,
    };
  }

  try {
    const preflight = await dependencies.verifyScope(prisma, context.config);
    const profileOff = preflight.reason === "PROFILE_OFF";
    const status = profileOff ? ApmsRuntimeStatus.OFF : ApmsRuntimeStatus.ACTIVE;
    const preflightStatus = profileOff
      ? ApmsRuntimePreflightStatus.NOT_REQUIRED
      : ApmsRuntimePreflightStatus.PASSED;

    if (!statePersisted || !snapshotPersisted || !context.stateId) {
      const stateError: GuestJourneyRuntimeSafeError = {
        code: "GUEST_JOURNEY_RUNTIME_STATE_NOT_PERSISTED",
        message: "The Guest Journey runtime state could not be persisted.",
        runtimeStatus: ApmsRuntimeStatus.BLOCKED,
      };
      await dependencies.persistFailureIssue(prisma, context, stateError, now).catch(
        () => null
      );
      return {
        allowed: false,
        statePersisted: false,
        status: ApmsRuntimeStatus.BLOCKED,
        preflightStatus: ApmsRuntimePreflightStatus.FAILED,
        preflight,
        error: stateError,
      };
    }

    await prisma.apmsRuntimeState.update({
      where: { id: context.stateId },
      data: {
        status,
        preflightStatus,
        lastPreflightAt: now,
        lastPreflightErrorCode: null,
        lastPreflightErrorMessage: null,
        lastHeartbeatAt: now,
      },
    });
    await dependencies.resolveFailureIssue(prisma, context, now);
    return {
      allowed: true,
      statePersisted: true,
      status,
      preflightStatus,
      preflight,
      error: null,
    };
  } catch (error) {
    const safeError = sanitizeGuestJourneyRuntimeError(error);
    if (statePersisted) {
      await persistRuntimeErrorState(
        prisma,
        context,
        safeError,
        now,
        dependencies.persistFailureIssue
      ).catch(() => false);
    }
    return {
      allowed: false,
      statePersisted,
      status: safeError.runtimeStatus,
      preflightStatus: ApmsRuntimePreflightStatus.FAILED,
      preflight: null,
      error: safeError,
    };
  }
}

export async function recordGuestJourneyRuntimeHeartbeat(
  prisma: PrismaClient,
  context: GuestJourneyRuntimeContext,
  now: Date = new Date()
): Promise<boolean> {
  const statePersisted = await ensureRuntimeStateRow(prisma, context, now);
  if (!statePersisted || !context.stateId) return false;
  const result = await prisma.apmsRuntimeState.updateMany({
    where: { id: context.stateId },
    data: { lastHeartbeatAt: now },
  });
  return result.count === 1;
}

export function isGuestJourneyRuntimeScopeMatch(
  runtime: {
    activationProfile: string | null;
    organizationScopeHashes: unknown;
    propertyScopeHashes: unknown;
  },
  input: { organizationId: string; propertyId: string }
): boolean {
  if (runtime.activationProfile === "off") return true;
  const organizationHashes = Array.isArray(runtime.organizationScopeHashes)
    ? runtime.organizationScopeHashes.map(String)
    : [];
  const propertyHashes = Array.isArray(runtime.propertyScopeHashes)
    ? runtime.propertyScopeHashes.map(String)
    : [];
  return (
    organizationHashes.includes(
      hashGuestJourneyRuntimeScopeId("organization", input.organizationId)
    ) ||
    propertyHashes.includes(
      hashGuestJourneyRuntimeScopeId("property", input.propertyId)
    )
  );
}
