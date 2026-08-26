import type {
  AutopilotStatus,
  EngineHealth,
  MissionControlOperationalItem,
} from "./mission-control-types";
import {
  GUEST_JOURNEY_RUNTIME_STALE_AFTER_MS,
  isGuestJourneyRuntimeScopeMatch,
} from "../services/guest-journey-runtime-state.service";

export type MissionControlRuntimeHealthRow = {
  runtimeName: string;
  environment: string;
  serviceName: string;
  activationProfile: string | null;
  configFingerprint: string;
  scopeFingerprint: string;
  organizationScopeHashes: unknown;
  propertyScopeHashes: unknown;
  status:
    | "OFF"
    | "STARTING"
    | "ACTIVE"
    | "BLOCKED"
    | "ERROR";
  preflightStatus:
    | "NOT_REQUIRED"
    | "PENDING"
    | "PASSED"
    | "FAILED";
  lastHeartbeatAt: Date;
};

export type MissionControlNativeHealth = {
  autopilotStatus: AutopilotStatus;
  engineHealth: EngineHealth[];
  runtimeFresh: boolean;
  runtimeApplicable: boolean;
  runtimeDriftDetected: boolean;
};

function timestamp(
  value: Date | string | null | undefined
): number {
  if (value instanceof Date) return value.getTime();
  if (!value) return 0;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? 0
    : parsed.getTime();
}

function runtimeVariant(
  runtime: MissionControlRuntimeHealthRow
) {
  return [
    runtime.activationProfile ?? "INVALID",
    runtime.configFingerprint,
    runtime.scopeFingerprint,
  ].join(":");
}

function healthRank(
  status: EngineHealth["status"]
) {
  if (status === "ERROR") return 3;
  if (status === "WARNING") return 2;
  return 1;
}

function mergeEngineHealth(
  entries: EngineHealth[]
): EngineHealth[] {
  const byEngine = new Map<string, EngineHealth>();

  for (const entry of entries) {
    const existing = byEngine.get(entry.engine);

    if (
      !existing ||
      healthRank(entry.status) >
        healthRank(existing.status) ||
      (healthRank(entry.status) ===
        healthRank(existing.status) &&
        timestamp(entry.lastExecutionAt) >
          timestamp(existing.lastExecutionAt))
    ) {
      byEngine.set(entry.engine, entry);
    }
  }

  return Array.from(byEngine.values()).sort(
    (left, right) =>
      left.engine.localeCompare(right.engine)
  );
}

function genericInternalMessage(engine: string) {
  return `Pin&Go detected an internal ${engine} condition and is protecting the affected workflow.`;
}

function projectCurrentIssueHealth(
  issues: readonly MissionControlOperationalItem[]
): EngineHealth[] {
  const byEngine = new Map<
    string,
    MissionControlOperationalItem[]
  >();

  for (const issue of issues) {
    if (issue.workflowState === "RESOLVED") continue;

    const engine =
      String(issue.engine ?? "APMS").trim() ||
      "APMS";
    const current = byEngine.get(engine) ?? [];
    current.push(issue);
    byEngine.set(engine, current);
  }

  return Array.from(byEngine.entries()).map(
    ([engine, engineIssues]) => {
      const ordered = [...engineIssues].sort(
        (left, right) =>
          timestamp(right.lastSignalAt) -
          timestamp(left.lastSignalAt)
      );
      const latest = ordered[0];
      const critical = engineIssues.some(
        (issue) =>
          issue.severity === "CRITICAL"
      );
      const message =
        latest?.visibility === "HOST"
          ? latest.operationalImpact ??
            latest.issue ??
            latest.title
          : genericInternalMessage(engine);
      const lastExecutionTimestamp = latest
        ? timestamp(latest.lastSignalAt) ||
          timestamp(latest.firstDetectedAt)
        : 0;
      const health: EngineHealth = {
        engine,
        status: critical ? "ERROR" : "WARNING",
      };

      if (message) health.message = message;
      if (lastExecutionTimestamp > 0) {
        health.lastExecutionAt = new Date(
          lastExecutionTimestamp
        );
      }

      return health;
    }
  );
}

/**
 * Native E13 Mission Control precedence:
 * 1. runtime BLOCKED/ERROR, failed preflight, drift, or unresolved CRITICAL -> ERROR
 * 2. HOST ACTION_REQUIRED -> NEEDS_ATTENTION
 * 3. runtime missing, stale, OFF, STARTING, or out of property scope -> PAUSED
 * 4. enabled, fresh, applicable, preflight-passed runtime -> ACTIVE
 */
export function deriveMissionControlNativeHealth(
  input: {
    runtimeRows:
      readonly MissionControlRuntimeHealthRow[];
    allVisibilityCurrentIssues:
      readonly MissionControlOperationalItem[];
    organizationId: string;
    propertyId: string;
    now?: Date;
    staleAfterMs?: number;
  }
): MissionControlNativeHealth {
  const now = input.now ?? new Date();
  const staleAfterMs =
    input.staleAfterMs ??
    GUEST_JOURNEY_RUNTIME_STALE_AFTER_MS;
  const freshFrom = now.getTime() - staleAfterMs;
  const orderedRuntimes = [
    ...input.runtimeRows,
  ].sort(
    (left, right) =>
      right.lastHeartbeatAt.getTime() -
      left.lastHeartbeatAt.getTime()
  );
  const freshRuntimes = orderedRuntimes.filter(
    (runtime) =>
      runtime.lastHeartbeatAt.getTime() >= freshFrom
  );
  const runtimeDriftDetected =
    new Set(
      freshRuntimes.map(runtimeVariant)
    ).size > 1;
  const runtimeFailure = freshRuntimes.some(
    (runtime) =>
      runtime.status === "BLOCKED" ||
      runtime.status === "ERROR" ||
      runtime.preflightStatus === "FAILED"
  );
  const currentHealthIssues =
    input.allVisibilityCurrentIssues.filter(
      (issue) => {
        const runtimeFailureIssue =
          issue.issueCode ===
            "GUEST_JOURNEY_RUNTIME_BLOCKED" &&
          issue.engine === "GUEST_JOURNEY";

        return (
          !runtimeFailureIssue ||
          runtimeFailure
        );
      }
    );
  const hasCriticalIssue =
    currentHealthIssues.some(
      (issue) =>
        issue.workflowState !== "RESOLVED" &&
        issue.severity === "CRITICAL"
    );
  const hasHostAction =
    currentHealthIssues.some(
      (issue) =>
        issue.workflowState ===
          "ACTION_REQUIRED" &&
        issue.visibility === "HOST" &&
        issue.actionRequired === true
    );
  const applicableFreshRuntimes =
    freshRuntimes.filter((runtime) =>
      isGuestJourneyRuntimeScopeMatch(
        runtime,
        {
          organizationId: input.organizationId,
          propertyId: input.propertyId,
        }
      )
    );
  const activeRuntime =
    applicableFreshRuntimes.find(
      (runtime) =>
        runtime.status === "ACTIVE" &&
        runtime.preflightStatus === "PASSED" &&
        runtime.activationProfile !== "off"
    );
  const runtimeOffOrStarting =
    applicableFreshRuntimes.length === 0 ||
    applicableFreshRuntimes.every(
      (runtime) =>
        runtime.status === "OFF" ||
        runtime.status === "STARTING" ||
        runtime.activationProfile === "off"
    );

  const autopilotStatus: AutopilotStatus =
    runtimeDriftDetected ||
    runtimeFailure ||
    hasCriticalIssue
      ? "ERROR"
      : hasHostAction
      ? "NEEDS_ATTENTION"
      : runtimeOffOrStarting || !activeRuntime
      ? "PAUSED"
      : "ACTIVE";

  const issueHealth = projectCurrentIssueHealth(
    currentHealthIssues
  );
  const latestRuntime =
    applicableFreshRuntimes[0] ??
    freshRuntimes[0] ??
    orderedRuntimes[0];
  const runtimeHealth: EngineHealth = {
    engine: "GUEST_JOURNEY",
    status:
      runtimeDriftDetected || runtimeFailure
        ? "ERROR"
        : activeRuntime
        ? "HEALTHY"
        : "WARNING",
    message: runtimeDriftDetected
      ? "Pin&Go detected inconsistent Guest Journey runtime configuration and blocked enterprise execution."
      : runtimeFailure
      ? "Pin&Go blocked Guest Journey enterprise execution because its runtime preflight is not healthy."
      : activeRuntime
      ? "Guest Journey enterprise runtime is healthy."
      : "Guest Journey enterprise runtime is paused or awaiting a fresh heartbeat.",
  };

  if (latestRuntime) {
    runtimeHealth.lastExecutionAt =
      latestRuntime.lastHeartbeatAt;
  }

  return {
    autopilotStatus,
    engineHealth: mergeEngineHealth([
      ...issueHealth,
      runtimeHealth,
    ]),
    runtimeFresh: freshRuntimes.length > 0,
    runtimeApplicable:
      applicableFreshRuntimes.length > 0,
    runtimeDriftDetected,
  };
}
