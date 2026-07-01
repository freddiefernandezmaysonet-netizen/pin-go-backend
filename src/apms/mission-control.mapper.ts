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

type RecommendedActionV1 = MissionControlAction;

function normalizeAuditValueV1(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function getAuditTimestampV1(entry: AuditEntry) {
  return (
    entry.completedAt?.getTime?.() ??
    entry.startedAt?.getTime?.() ??
    0
  );
}

function isActionableAuditEntryV1(entry: AuditEntry) {
  const status = normalizeAuditValueV1(entry.status);
  const severity = normalizeAuditValueV1(entry.severity);

  return (
    status === "FAILED" ||
    status === "ERROR" ||
    severity === "WARNING" ||
    severity === "CRITICAL"
  );
}

function getRecommendedActionPriorityV1(
  entry: AuditEntry
): MissionControlAction["priority"] {
  const status = normalizeAuditValueV1(entry.status);
  const severity = normalizeAuditValueV1(entry.severity);

  if (severity === "CRITICAL") {
    return "CRITICAL";
  }

  if (status === "FAILED" || status === "ERROR") {
    return "HIGH";
  }

  if (severity === "WARNING") {
    return "MEDIUM";
  }

  return "LOW";
}

function getRecommendedActionSortRankV1(action: RecommendedActionV1) {
  const priorityRank =
    action.priority === "CRITICAL"
      ? 0
      : action.priority === "HIGH"
      ? 1
      : action.priority === "MEDIUM"
      ? 2
      : 3;

  const engineRank =
    action.engine === "Distribution"
      ? 0
      : action.engine === "Access"
      ? 1
      : action.engine === "Cleaning" || action.engine === "Messaging"
      ? 2
      : action.engine === "Revenue"
      ? 3
      : action.engine === "Reservation"
      ? 4
      : 5;

  return priorityRank * 10 + engineRank;
}

function getHostFriendlyActionV1(entry: AuditEntry): RecommendedActionV1 {
  const engine = String(entry.engine ?? "MissionControl");
  const reason = normalizeAuditValueV1(entry.reason);
  const priority = getRecommendedActionPriorityV1(entry);

  if (engine === "Distribution") {
    let description =
      "Pin&Go could not confirm the latest channel sync. Review the Channex connection and retry sync.";

    if (reason.includes("NIGHTLY_RATE")) {
      description =
        "Pin&Go could not confirm the channel sync after a nightly rate update. Review the Channex connection and retry sync.";
    } else if (reason.includes("BLOCKED_DATE")) {
      description =
        "Pin&Go could not confirm the channel sync after a calendar availability change. Review the Channex connection and retry sync.";
    } else if (reason.includes("MANUAL_RESERVATION")) {
      description =
        "Pin&Go could not confirm the channel sync after a reservation update. Review the Channex connection and retry sync.";
    } else if (reason.includes("SEASON")) {
      description =
        "Pin&Go could not confirm the channel sync after a seasonal pricing update. Review the Channex connection and retry sync.";
    } else if (reason.includes("HOLIDAY")) {
      description =
        "Pin&Go could not confirm the channel sync after a holiday pricing update. Review the Channex connection and retry sync.";
    }

    return {
      title: "Channel sync needs review",
      description,
      engine,
      priority,
      requiresHumanAction: true,
    };
  }

  if (engine === "Access") {
    const description = reason.includes("ACTIVE_LOCK_MISSING")
      ? "Pin&Go could not find an active lock for this reservation. Assign an active lock and verify guest access."
      : "Pin&Go could not confirm guest access for this reservation. Review the lock and access setup.";

    return {
      title: "Guest access needs review",
      description,
      engine,
      priority,
      requiresHumanAction: true,
    };
  }

  if (engine === "Cleaning") {
    const description = reason.includes("CLEANING_STAFF_MISSING")
      ? "Pin&Go could not assign a cleaner for this reservation. Assign a cleaner and verify the cleaning confirmation."
      : "Pin&Go could not confirm the cleaning setup for this reservation. Review the cleaner assignment and confirmation.";

    return {
      title: "Cleaning schedule needs review",
      description,
      engine,
      priority,
      requiresHumanAction: true,
    };
  }

  if (engine === "Messaging") {
    return {
      title: "Guest message needs review",
      description:
        "Pin&Go could not confirm message delivery. Review guest or staff communication and retry if needed.",
      engine,
      priority,
      requiresHumanAction: true,
    };
  }

  if (engine === "Revenue") {
    return {
      title: "Pricing guardrail needs review",
      description:
        "Pin&Go detected a pricing condition that needs review. Check the property pricing limits and revenue settings.",
      engine,
      priority,
      requiresHumanAction: true,
    };
  }

  if (engine === "Reservation") {
    return {
      title: "Reservation needs review",
      description:
        "Pin&Go detected a reservation issue that needs review. Check reservation details, payment state, access, and operational status.",
      engine,
      priority,
      requiresHumanAction: true,
    };
  }

  return {
    title: "APMS operation needs review",
    description:
      "Pin&Go detected an operational issue that needs review in Mission Control.",
    engine,
    priority,
    requiresHumanAction: true,
  };
}

function getRecommendedActionDedupKeyV1(
  action: RecommendedActionV1,
  entry: AuditEntry
) {
  return [
    action.engine,
    action.title.trim().toLowerCase(),
    normalizeAuditValueV1(entry.reason),
  ].join(":");
}

function buildRecommendedActionsV1(
  auditEntries: AuditEntry[]
): MissionControlAction[] {
  const actionsByKey = new Map<
    string,
    { action: RecommendedActionV1; entry: AuditEntry }
  >();

  for (const entry of auditEntries) {
    if (!isActionableAuditEntryV1(entry)) {
      continue;
    }

    const action = getHostFriendlyActionV1(entry);
    const key = getRecommendedActionDedupKeyV1(action, entry);
    const existing = actionsByKey.get(key);

    if (!existing) {
      actionsByKey.set(key, { action, entry });
      continue;
    }

    const existingRank = getRecommendedActionSortRankV1(existing.action);
    const nextRank = getRecommendedActionSortRankV1(action);

    if (
      nextRank < existingRank ||
      getAuditTimestampV1(entry) > getAuditTimestampV1(existing.entry)
    ) {
      actionsByKey.set(key, { action, entry });
    }
  }

  const actions = Array.from(actionsByKey.values())
    .map((item) => item.action)
    .sort(
      (actionA, actionB) =>
        getRecommendedActionSortRankV1(actionA) -
        getRecommendedActionSortRankV1(actionB)
    );

  if (actions.length > 0) {
    return actions;
  }

  return [
    {
      title: "No action needed",
      description:
        "Pin&Go handled the latest property operations automatically. No host action is needed right now.",
      engine: "MissionControl",
      priority: "LOW",
      requiresHumanAction: false,
    },
  ];
}

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
  const recommendedActions = buildRecommendedActionsV1(input.auditEntries);
  
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