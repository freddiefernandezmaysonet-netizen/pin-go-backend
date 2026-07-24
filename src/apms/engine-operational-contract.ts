import type {
  OperationalActor,
  OperationalWorkflowState,
} from "./operational-intelligence-types";

export const APMS_ENGINE_IDS = [
  "GUEST_JOURNEY",
  "ACCESS",
  "DEVICE_HEALTH",
  "COMMUNICATIONS",
  "CLEANING",
  "DISTRIBUTION_PMS",
  "REVENUE",
  "FINANCIAL",
] as const;

export type ApmsEngineId =
  (typeof APMS_ENGINE_IDS)[number];

export const APMS_ENGINE_DISPLAY_NAMES: Record<
  ApmsEngineId,
  string
> = {
  GUEST_JOURNEY: "Guest Journey",
  ACCESS: "Access",
  DEVICE_HEALTH: "Device Health",
  COMMUNICATIONS: "Communications",
  CLEANING: "Cleaning",
  DISTRIBUTION_PMS: "Distribution / PMS",
  REVENUE: "Revenue",
  FINANCIAL: "Financial",
};

export const MISSION_CONTROL_ENGINE_STATES = [
  "HEALTHY",
  "AUTO_RESOLVING",
  "HOST_ACTION_REQUIRED",
  "DISABLED",
] as const;

export type MissionControlEngineState =
  (typeof MISSION_CONTROL_ENGINE_STATES)[number];

export const MISSION_CONTROL_STATE_PRECEDENCE: Record<
  MissionControlEngineState,
  number
> = {
  HEALTHY: 0,
  DISABLED: 1,
  AUTO_RESOLVING: 2,
  HOST_ACTION_REQUIRED: 3,
};

export type MissionControlDependencyState =
  | "AVAILABLE"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "NOT_APPLICABLE";

export interface MissionControlEngineDependency {
  code: string;
  state: MissionControlDependencyState;
  summary?: string | null;
  lastCheckedAt?: Date | string | null;
}

export type MissionControlEvidenceKind =
  | "OPERATIONAL_ISSUE"
  | "AUDIT_ENTRY"
  | "DOMAIN_ENTITY";

export interface MissionControlEvidenceRef {
  kind: MissionControlEvidenceKind;
  id: string;
}

export interface MissionControlEngineSnapshot {
  engineId: ApmsEngineId;
  displayName: string;
  state: MissionControlEngineState;

  enabled: boolean;
  configured: boolean;
  applicable: boolean;

  reasonCode: string;
  summary: string;
  hostActionRequired: boolean;

  activeIssueCount: number;
  hostActionCount: number;
  autoResolvingCount: number;

  nextAutomaticStep?: string | null;
  nextAttemptAt?: Date | string | null;
  attempt?: number | null;
  maxAttempts?: number | null;
  exhausted: boolean;

  lastSignalAt?: Date | string | null;
  lastSuccessAt?: Date | string | null;
  staleAt?: Date | string | null;

  dependencies: MissionControlEngineDependency[];
  evidenceRefs: MissionControlEvidenceRef[];
}

export interface MissionControlStateCounts {
  healthy: number;
  autoResolving: number;
  hostActionRequired: number;
  disabled: number;
}

export interface MissionControlReadModelV1 {
  schemaVersion: 1;
  organizationId: string;
  generatedAt: Date | string;

  needsHostAction: boolean;
  hostActionCount: number;
  autoResolvingCount: number;
  headline: string;

  counts: MissionControlStateCounts;
  engines: MissionControlEngineSnapshot[];
}

export interface MissionControlOperationalSignal {
  workflowState: OperationalWorkflowState;
  actionRequired: boolean;
  responsibleActor: OperationalActor;
}

export interface ResolveMissionControlEngineStateInput {
  enabled: boolean;
  configured: boolean;
  applicable: boolean;
  activeSignals: MissionControlOperationalSignal[];
}

const ENGINE_ALIASES: Record<string, ApmsEngineId> = {
  GUESTJOURNEY: "GUEST_JOURNEY",
  GUEST_JOURNEY: "GUEST_JOURNEY",
  ACCESS: "ACCESS",
  DEVICEHEALTH: "DEVICE_HEALTH",
  DEVICE_HEALTH: "DEVICE_HEALTH",
  COMMUNICATIONS: "COMMUNICATIONS",
  COMMUNICATION: "COMMUNICATIONS",
  MESSAGING: "COMMUNICATIONS",
  CLEANING: "CLEANING",
  DISTRIBUTION: "DISTRIBUTION_PMS",
  PMS: "DISTRIBUTION_PMS",
  DISTRIBUTIONPMS: "DISTRIBUTION_PMS",
  DISTRIBUTION_PMS: "DISTRIBUTION_PMS",
  REVENUE: "REVENUE",
  FINANCIAL: "FINANCIAL",
  FINANCE: "FINANCIAL",
  PAYMENT: "FINANCIAL",
  PAYOUTS: "FINANCIAL",
};

function normalizeEngineAlias(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/&/g, "AND")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeApmsEngineId(
  value: unknown
): ApmsEngineId | null {
  const normalized = normalizeEngineAlias(value);

  if (!normalized) {
    return null;
  }

  return (
    ENGINE_ALIASES[normalized] ??
    ENGINE_ALIASES[normalized.replace(/_/g, "")] ??
    null
  );
}

export function isHostActionSignal(
  signal: MissionControlOperationalSignal
) {
  return (
    signal.workflowState === "ACTION_REQUIRED" &&
    signal.actionRequired === true &&
    signal.responsibleActor === "HOST"
  );
}

export function isAutomaticWorkSignal(
  signal: MissionControlOperationalSignal
) {
  if (isHostActionSignal(signal)) {
    return false;
  }

  return (
    signal.workflowState === "WAITING" ||
    signal.workflowState === "AUTO_RESOLVING" ||
    signal.workflowState === "ACTION_REQUIRED"
  );
}

export function resolveMissionControlEngineState(
  input: ResolveMissionControlEngineStateInput
): MissionControlEngineState {
  if (input.activeSignals.some(isHostActionSignal)) {
    return "HOST_ACTION_REQUIRED";
  }

  if (input.activeSignals.some(isAutomaticWorkSignal)) {
    return "AUTO_RESOLVING";
  }

  if (
    !input.applicable ||
    !input.enabled ||
    !input.configured
  ) {
    return "DISABLED";
  }

  return "HEALTHY";
}

export function getMissionControlStateCounts(
  engines: MissionControlEngineSnapshot[]
): MissionControlStateCounts {
  const counts: MissionControlStateCounts = {
    healthy: 0,
    autoResolving: 0,
    hostActionRequired: 0,
    disabled: 0,
  };

  for (const engine of engines) {
    if (engine.state === "HEALTHY") {
      counts.healthy += 1;
    } else if (engine.state === "AUTO_RESOLVING") {
      counts.autoResolving += 1;
    } else if (engine.state === "HOST_ACTION_REQUIRED") {
      counts.hostActionRequired += 1;
    } else {
      counts.disabled += 1;
    }
  }

  return counts;
}
