import {
  APMS_ENGINE_DISPLAY_NAMES,
  APMS_ENGINE_IDS,
  getMissionControlStateCounts,
  isAutomaticWorkSignal,
  isHostActionSignal,
  normalizeApmsEngineId,
  resolveMissionControlEngineState,
} from "./engine-operational-contract";
import type {
  ApmsEngineId,
  MissionControlEngineDependency,
  MissionControlEngineSnapshot,
  MissionControlEvidenceRef,
  MissionControlReadModelV1,
} from "./engine-operational-contract";
import type {
  OperationalActor,
  OperationalWorkflowState,
} from "./operational-intelligence-types";

export interface MissionControlEngineReadiness {
  enabled: boolean;
  configured: boolean;
  applicable: boolean;
  reasonCode: string;
  summary: string;
  lastSuccessAt?: Date | string | null;
  staleAt?: Date | string | null;
  dependencies?: MissionControlEngineDependency[];
  evidenceRefs?: MissionControlEvidenceRef[];
}

export interface MissionControlOperationalProjection {
  issueId?: string | null;
  issueCode: string;
  title: string;
  issue: string;
  engine: string;
  workflowState: OperationalWorkflowState;
  actionRequired: boolean;
  responsibleActor: OperationalActor;
  nextAutomaticStep?: string | null;
  lastSignalAt: Date | string;
  nextAttemptAt?: Date | string | null;
  attempt?: number | null;
  maxAttempts?: number | null;
  exhausted?: boolean;
}

export interface BuildMissionControlReadModelInput {
  organizationId: string;
  generatedAt?: Date;
  readiness: Record<
    ApmsEngineId,
    MissionControlEngineReadiness
  >;
  operationalItems: MissionControlOperationalProjection[];
}

function getTimestamp(value: Date | string | null | undefined) {
  if (!value) {
    return 0;
  }

  const timestamp =
    value instanceof Date
      ? value.getTime()
      : new Date(value).getTime();

  return Number.isFinite(timestamp)
    ? timestamp
    : 0;
}

function sortByLatestSignal(
  left: MissionControlOperationalProjection,
  right: MissionControlOperationalProjection
) {
  return (
    getTimestamp(right.lastSignalAt) -
    getTimestamp(left.lastSignalAt)
  );
}

function getPrimaryIssue(
  items: MissionControlOperationalProjection[],
  predicate: (
    item: MissionControlOperationalProjection
  ) => boolean
) {
  return items
    .filter(predicate)
    .sort(sortByLatestSignal)[0] ?? null;
}

function getIssueEvidenceRefs(
  items: MissionControlOperationalProjection[]
): MissionControlEvidenceRef[] {
  const issueIds = new Set<string>();

  for (const item of items) {
    const issueId = String(
      item.issueId ?? ""
    ).trim();

    if (issueId) {
      issueIds.add(issueId);
    }
  }

  return Array.from(issueIds).map((id) => ({
    kind: "OPERATIONAL_ISSUE" as const,
    id,
  }));
}

function buildEngineSnapshot(input: {
  engineId: ApmsEngineId;
  readiness: MissionControlEngineReadiness;
  operationalItems: MissionControlOperationalProjection[];
}): MissionControlEngineSnapshot {
  const activeItems = input.operationalItems
    .filter(
      (item) =>
        item.workflowState !== "RESOLVED"
    )
    .sort(sortByLatestSignal);

  const signals = activeItems.map((item) => ({
    workflowState: item.workflowState,
    actionRequired: item.actionRequired,
    responsibleActor: item.responsibleActor,
  }));

  const state = resolveMissionControlEngineState({
    enabled: input.readiness.enabled,
    configured: input.readiness.configured,
    applicable: input.readiness.applicable,
    activeSignals: signals,
  });

  const hostItems = activeItems.filter((item) =>
    isHostActionSignal({
      workflowState: item.workflowState,
      actionRequired: item.actionRequired,
      responsibleActor: item.responsibleActor,
    })
  );

  const automaticItems = activeItems.filter((item) =>
    isAutomaticWorkSignal({
      workflowState: item.workflowState,
      actionRequired: item.actionRequired,
      responsibleActor: item.responsibleActor,
    })
  );

  const primaryHostIssue = getPrimaryIssue(
    hostItems,
    () => true
  );
  const primaryAutomaticIssue = getPrimaryIssue(
    automaticItems,
    () => true
  );
  const primaryIssue =
    primaryHostIssue ??
    primaryAutomaticIssue;

  const reasonCode =
    primaryIssue?.issueCode ??
    input.readiness.reasonCode;

  const summary =
    state === "HOST_ACTION_REQUIRED"
      ? primaryHostIssue?.issue ??
        primaryHostIssue?.title ??
        input.readiness.summary
      : state === "AUTO_RESOLVING"
      ? primaryAutomaticIssue
          ?.nextAutomaticStep ??
        primaryAutomaticIssue?.issue ??
        input.readiness.summary
      : input.readiness.summary;

  const readinessEvidenceRefs =
    input.readiness.evidenceRefs ?? [];

  return {
    engineId: input.engineId,
    displayName:
      APMS_ENGINE_DISPLAY_NAMES[
        input.engineId
      ],
    state,

    enabled: input.readiness.enabled,
    configured:
      input.readiness.configured,
    applicable:
      input.readiness.applicable,

    reasonCode,
    summary,
    hostActionRequired:
      state === "HOST_ACTION_REQUIRED",

    activeIssueCount: activeItems.length,
    hostActionCount: hostItems.length,
    autoResolvingCount:
      automaticItems.length,

    nextAutomaticStep:
      state === "AUTO_RESOLVING"
        ? primaryAutomaticIssue
            ?.nextAutomaticStep ?? null
        : null,
    nextAttemptAt:
      state === "AUTO_RESOLVING"
        ? primaryAutomaticIssue
            ?.nextAttemptAt ?? null
        : null,
    attempt:
      primaryIssue?.attempt ?? null,
    maxAttempts:
      primaryIssue?.maxAttempts ?? null,
    exhausted:
      state === "HOST_ACTION_REQUIRED" &&
      primaryHostIssue?.exhausted === true,

    lastSignalAt:
      primaryIssue?.lastSignalAt ?? null,
    lastSuccessAt:
      input.readiness.lastSuccessAt ?? null,
    staleAt:
      input.readiness.staleAt ?? null,

    dependencies:
      input.readiness.dependencies ?? [],
    evidenceRefs: [
      ...readinessEvidenceRefs,
      ...getIssueEvidenceRefs(activeItems),
    ],
  };
}

function buildHeadline(input: {
  hostActionCount: number;
  autoResolvingCount: number;
}) {
  if (input.hostActionCount > 0) {
    return input.hostActionCount === 1
      ? "Pin&Go needs one action from you."
      : `Pin&Go needs ${input.hostActionCount} actions from you.`;
  }

  if (input.autoResolvingCount > 0) {
    return input.autoResolvingCount === 1
      ? "Pin&Go is resolving one event automatically."
      : `Pin&Go is resolving ${input.autoResolvingCount} events automatically.`;
  }

  return "Everything applicable is under control.";
}

export function buildMissionControlReadModel(
  input: BuildMissionControlReadModelInput
): MissionControlReadModelV1 {
  const operationalItemsByEngine = new Map<
    ApmsEngineId,
    MissionControlOperationalProjection[]
  >();

  for (const engineId of APMS_ENGINE_IDS) {
    operationalItemsByEngine.set(
      engineId,
      []
    );
  }

  for (const item of input.operationalItems) {
    const engineId = normalizeApmsEngineId(
      item.engine
    );

    if (!engineId) {
      continue;
    }

    operationalItemsByEngine
      .get(engineId)
      ?.push(item);
  }

  const engines = APMS_ENGINE_IDS.map(
    (engineId) =>
      buildEngineSnapshot({
        engineId,
        readiness:
          input.readiness[engineId],
        operationalItems:
          operationalItemsByEngine.get(
            engineId
          ) ?? [],
      })
  );

  const counts =
    getMissionControlStateCounts(
      engines
    );
  const hostActionCount = engines.reduce(
    (total, engine) =>
      total + engine.hostActionCount,
    0
  );
  const autoResolvingCount =
    engines.reduce(
      (total, engine) =>
        total +
        engine.autoResolvingCount,
      0
    );

  return {
    schemaVersion: 1,
    organizationId:
      input.organizationId,
    generatedAt:
      input.generatedAt ?? new Date(),

    needsHostAction:
      hostActionCount > 0,
    hostActionCount,
    autoResolvingCount,
    headline: buildHeadline({
      hostActionCount,
      autoResolvingCount,
    }),

    counts,
    engines,
  };
}
