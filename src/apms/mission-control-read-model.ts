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
  MissionControlResolvedWorkflowSummary,
  MissionControlWorkflowSummary,
} from "./engine-operational-contract";
import type {
  OperationalActionTarget,
  OperationalActor,
  OperationalResolutionType,
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
  recommendedAction?: string | null;
  nextAutomaticStep?: string | null;
  actionTarget?: OperationalActionTarget | null;
  reservationId?: string | null;
  reservationNumber?: string | null;
  propertyId?: string | null;
  guestName?: string | null;
  cleanerName?: string | null;
  lastSignalAt: Date | string;
  resolvedAt?: Date | string | null;
  resolutionSummary?: string | null;
  resolutionType?: OperationalResolutionType | null;
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

type NormalizedOperationalProjection = {
  engineId: ApmsEngineId;
  item: MissionControlOperationalProjection;
};

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

function sortByLatestResolution(
  left: MissionControlOperationalProjection,
  right: MissionControlOperationalProjection
) {
  return (
    getTimestamp(
      right.resolvedAt ?? right.lastSignalAt
    ) -
    getTimestamp(
      left.resolvedAt ?? left.lastSignalAt
    )
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

function isHostActionItem(
  item: MissionControlOperationalProjection
) {
  return isHostActionSignal({
    workflowState: item.workflowState,
    actionRequired: item.actionRequired,
    responsibleActor: item.responsibleActor,
  });
}

function isAutomaticWorkItem(
  item: MissionControlOperationalProjection
) {
  return isAutomaticWorkSignal({
    workflowState: item.workflowState,
    actionRequired: item.actionRequired,
    responsibleActor: item.responsibleActor,
  });
}

function toWorkflowSummary(
  engineId: ApmsEngineId,
  item: MissionControlOperationalProjection
): MissionControlWorkflowSummary {
  return {
    issueCode: item.issueCode,
    engineId,
    workflowState: item.workflowState,

    title: item.title,
    issue: item.issue,
    recommendedAction:
      item.recommendedAction ?? null,
    nextAutomaticStep:
      item.nextAutomaticStep ?? null,

    responsibleActor:
      item.responsibleActor,
    actionTarget:
      item.actionTarget ?? null,

    reservationId:
      item.reservationId ?? null,
    reservationNumber:
      item.reservationNumber ?? null,
    propertyId:
      item.propertyId ?? null,
    guestName:
      item.guestName ?? null,
    cleanerName:
      item.cleanerName ?? null,

    lastSignalAt: item.lastSignalAt,
    nextAttemptAt:
      item.nextAttemptAt ?? null,
    attempt:
      item.attempt ?? null,
    maxAttempts:
      item.maxAttempts ?? null,
    exhausted:
      isHostActionItem(item) &&
      item.exhausted === true,
  };
}

function toResolvedWorkflowSummary(
  engineId: ApmsEngineId,
  item: MissionControlOperationalProjection
): MissionControlResolvedWorkflowSummary {
  return {
    ...toWorkflowSummary(
      engineId,
      item
    ),
    resolvedAt:
      item.resolvedAt ??
      item.lastSignalAt,
    resolutionSummary:
      item.resolutionSummary ?? null,
    resolutionType:
      item.resolutionType ?? null,
    exhausted: false,
  };
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

  const hostItems = activeItems.filter(
    isHostActionItem
  );

  const automaticItems = activeItems.filter(
    isAutomaticWorkItem
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

  const normalizedOperationalItems:
    NormalizedOperationalProjection[] = [];

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
    normalizedOperationalItems.push({
      engineId,
      item,
    });
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

  const hostActions =
    normalizedOperationalItems
      .filter(
        ({ item }) =>
          item.workflowState !== "RESOLVED" &&
          isHostActionItem(item)
      )
      .sort((left, right) =>
        sortByLatestSignal(
          left.item,
          right.item
        )
      )
      .map(({ engineId, item }) =>
        toWorkflowSummary(
          engineId,
          item
        )
      );

  const automaticWork =
    normalizedOperationalItems
      .filter(
        ({ item }) =>
          item.workflowState !== "RESOLVED" &&
          isAutomaticWorkItem(item)
      )
      .sort((left, right) =>
        sortByLatestSignal(
          left.item,
          right.item
        )
      )
      .map(({ engineId, item }) =>
        toWorkflowSummary(
          engineId,
          item
        )
      );

  const recentResolutions =
    normalizedOperationalItems
      .filter(
        ({ item }) =>
          item.workflowState === "RESOLVED"
      )
      .sort((left, right) =>
        sortByLatestResolution(
          left.item,
          right.item
        )
      )
      .map(({ engineId, item }) =>
        toResolvedWorkflowSummary(
          engineId,
          item
        )
      );

  const counts =
    getMissionControlStateCounts(
      engines
    );
  const hostActionCount =
    hostActions.length;
  const autoResolvingCount =
    automaticWork.length;

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
    hostActions,
    automaticWork,
    recentResolutions,
  };
}
