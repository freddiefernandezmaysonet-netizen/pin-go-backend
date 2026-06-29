import type { AuditEntry } from "./audit-types";
import type {
  AutonomyScore,
  AutopilotStatus,
  ConfidenceScore,
  EngineHealth,
  FreedomMetrics,
  MissionControlAction,
  MissionControlSnapshot,
} from "./mission-control-types";

type MissionControlSnapshotInput = {
  entityId: string;
  auditEntries: AuditEntry[];
  generatedAt?: Date;

  /**
   * Optional caller-provided freedom metrics.
   *
   * We do not invent minutes returned here because Pin&Go should only
   * report time savings when the workflow has a trusted source for it.
   */
  freedomMetrics?: Partial<FreedomMetrics>;
};

function clampScore(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getAuditEntryCompletedAt(entry: AuditEntry) {
  return entry.completedAt ?? entry.startedAt;
}

function getRecommendedActionPriority(
  entry: AuditEntry
): MissionControlAction["priority"] {
  if (entry.severity === "CRITICAL") return "CRITICAL";
  if (entry.status === "FAILED") return "HIGH";
  if (entry.severity === "WARNING") return "MEDIUM";

  return "LOW";
}

function auditEntryRequiresHumanAction(entry: AuditEntry) {
  return entry.status === "FAILED" || entry.severity === "CRITICAL";
}

const recommendedActionPriorityWeight: Record<
  MissionControlAction["priority"],
  number
> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

function getRecommendedActionDedupKey(action: MissionControlAction) {
  return `${action.engine}:${action.title.trim().toLowerCase()}`;
}

function shouldReplaceRecommendedAction(
  currentAction: MissionControlAction,
  nextAction: MissionControlAction
) {
  const currentWeight =
    recommendedActionPriorityWeight[currentAction.priority] ?? 0;

  const nextWeight =
    recommendedActionPriorityWeight[nextAction.priority] ?? 0;

  if (nextWeight !== currentWeight) {
    return nextWeight > currentWeight;
  }

  if (
    nextAction.requiresHumanAction !==
    currentAction.requiresHumanAction
  ) {
    return nextAction.requiresHumanAction;
  }

  return false;
}

function mapAuditEntriesToRecommendedActions(
  auditEntries: AuditEntry[]
): MissionControlAction[] {
  const recommendedActionsByKey = new Map<
    string,
    MissionControlAction
  >();

  for (const entry of auditEntries) {
    if (!entry.recommendedAction) continue;

    const action: MissionControlAction = {
      title: entry.recommendedAction,
      description: entry.summary,
      engine: entry.engine,
      priority: getRecommendedActionPriority(entry),
      requiresHumanAction: auditEntryRequiresHumanAction(entry),
    };

    const dedupKey = getRecommendedActionDedupKey(action);
    const currentAction = recommendedActionsByKey.get(dedupKey);

    if (
      !currentAction ||
      shouldReplaceRecommendedAction(currentAction, action)
    ) {
      recommendedActionsByKey.set(dedupKey, action);
    }
  }

  return Array.from(recommendedActionsByKey.values()).sort(
    (actionA, actionB) => {
      const priorityDifference =
        (recommendedActionPriorityWeight[actionB.priority] ?? 0) -
        (recommendedActionPriorityWeight[actionA.priority] ?? 0);

      if (priorityDifference !== 0) {
        return priorityDifference;
      }

      if (
        actionA.requiresHumanAction !== actionB.requiresHumanAction
      ) {
        return actionA.requiresHumanAction ? -1 : 1;
      }

      const engineComparison = actionA.engine.localeCompare(
        actionB.engine
      );

      if (engineComparison !== 0) {
        return engineComparison;
      }

      return actionA.title.localeCompare(actionB.title);
    }
  );
}

function getAutopilotStatus(
  auditEntries: AuditEntry[],
  recommendedActions: MissionControlAction[]
): AutopilotStatus {
  if (
    auditEntries.some(
      (entry) => entry.status === "FAILED" || entry.severity === "CRITICAL"
    )
  ) {
    return "ERROR";
  }

  if (
    auditEntries.some((entry) => entry.severity === "WARNING") ||
    recommendedActions.some((action) => action.requiresHumanAction)
  ) {
    return "NEEDS_ATTENTION";
  }

  return "ACTIVE";
}

function getEngineHealth(auditEntries: AuditEntry[]): EngineHealth[] {
  const entriesByEngine = new Map<string, AuditEntry[]>();

  for (const entry of auditEntries) {
    const currentEntries = entriesByEngine.get(entry.engine) ?? [];
    currentEntries.push(entry);
    entriesByEngine.set(entry.engine, currentEntries);
  }

  return Array.from(entriesByEngine.entries()).map(([engine, entries]) => {
    const hasError = entries.some(
      (entry) => entry.status === "FAILED" || entry.severity === "CRITICAL"
    );

    const hasWarning = entries.some(
      (entry) => entry.status === "SKIPPED" || entry.severity === "WARNING"
    );

    const lastExecutionAt = entries
      .map(getAuditEntryCompletedAt)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    return {
      engine,
      status: hasError ? "ERROR" : hasWarning ? "WARNING" : "HEALTHY",
      lastExecutionAt,
      message: entries[entries.length - 1]?.summary,
    };
  });
}

function getConfidenceScore(auditEntries: AuditEntry[]): ConfidenceScore {
  const confidenceByEngine = new Map<string, number[]>();
  const allConfidenceValues: number[] = [];

  for (const entry of auditEntries) {
    const decisionConfidenceValues =
      entry.decisions
        ?.map((decision) => decision.confidence)
        .filter((confidence): confidence is number =>
          Number.isFinite(confidence)
        ) ?? [];

    const fallbackConfidence =
      decisionConfidenceValues.length > 0
        ? decisionConfidenceValues
        : [entry.status === "SUCCESS" ? 100 : 0];

    const engineConfidenceValues =
      confidenceByEngine.get(entry.engine) ?? [];

    engineConfidenceValues.push(...fallbackConfidence);
    confidenceByEngine.set(entry.engine, engineConfidenceValues);
    allConfidenceValues.push(...fallbackConfidence);
  }

  const engines = Object.fromEntries(
    Array.from(confidenceByEngine.entries()).map(([engine, values]) => {
      const average =
        values.length > 0
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : 0;

      return [engine, clampScore(average)];
    })
  );

  const overallAverage =
    allConfidenceValues.length > 0
      ? allConfidenceValues.reduce((sum, value) => sum + value, 0) /
        allConfidenceValues.length
      : 0;

  return {
    score: clampScore(overallAverage),
    engines,
  };
}

function getAutonomyScore(
  auditEntries: AuditEntry[],
  recommendedActions: MissionControlAction[]
): AutonomyScore {
  const totalEntries = auditEntries.length;
  const successfulEntries = auditEntries.filter(
    (entry) => entry.status === "SUCCESS"
  ).length;

  const humanInterventions = recommendedActions.filter(
    (action) => action.requiresHumanAction
  ).length;

  const operationalSuccessRate =
    totalEntries > 0 ? (successfulEntries / totalEntries) * 100 : 100;

  const score = clampScore(operationalSuccessRate - humanInterventions * 10);

  return {
    score,
    operationalSuccessRate: clampScore(operationalSuccessRate),
    humanInterventions,
  };
}

function getAutonomousDecisionCount(auditEntries: AuditEntry[]) {
  return auditEntries.reduce((count, entry) => {
    const appliedDecisionCount =
      entry.decisions?.filter((decision) => decision.applied).length ?? 0;

    return count + appliedDecisionCount;
  }, 0);
}

function getFreedomMetrics(
  auditEntries: AuditEntry[],
  inputMetrics?: Partial<FreedomMetrics>
): FreedomMetrics {
  const successfulEntries = auditEntries.filter(
    (entry) => entry.status === "SUCCESS"
  ).length;

  return {
    minutesReturned: inputMetrics?.minutesReturned ?? 0,
    interventionsAvoided:
      inputMetrics?.interventionsAvoided ?? successfulEntries,
    autonomousDecisions:
      inputMetrics?.autonomousDecisions ??
      getAutonomousDecisionCount(auditEntries),
  };
}

export function createMissionControlSnapshotFromAuditEntries(
  input: MissionControlSnapshotInput
): MissionControlSnapshot {
  const recommendedActions = mapAuditEntriesToRecommendedActions(
    input.auditEntries
  );

  return {
    entityId: input.entityId,
    autopilotStatus: getAutopilotStatus(
      input.auditEntries,
      recommendedActions
    ),
    freedomMetrics: getFreedomMetrics(
      input.auditEntries,
      input.freedomMetrics
    ),
    autonomyScore: getAutonomyScore(input.auditEntries, recommendedActions),
    confidenceScore: getConfidenceScore(input.auditEntries),
    engineHealth: getEngineHealth(input.auditEntries),
    recentAuditEntries: input.auditEntries.slice(-10),
    auditTimeline: {
      entityId: input.entityId,
      entityType: "PROPERTY",
      entries: input.auditEntries,
    },
    recommendedActions,
    generatedAt: input.generatedAt ?? new Date(),
  };
}