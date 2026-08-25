import type {
  AutopilotStatus,
  EngineHealth,
  MissionControlAction,
  MissionControlOperationalItem,
} from "./mission-control-types";

export interface MissionControlOperationalProjection {
  currentOperationalState: MissionControlOperationalItem[];
  hostActionQueue: MissionControlOperationalItem[];
  waitingItems: MissionControlOperationalItem[];
  autoResolvingItems: MissionControlOperationalItem[];
  recentlyResolved: MissionControlOperationalItem[];
}

export interface MissionControlCurrentStateSummary {
  autopilotStatus: AutopilotStatus;
  engineHealth: EngineHealth[];
}

/**
 * Produces the canonical Mission Control views from persisted operational
 * current state.
 *
 * This function is intentionally pure:
 * - it does not query Prisma;
 * - it does not mutate the supplied items;
 * - it does not infer workflow state from audit history;
 * - it does not expose SYSTEM or DEVELOPER issues to the host queue.
 */
export function projectMissionControlOperationalState(
  operationalItems: readonly MissionControlOperationalItem[]
): MissionControlOperationalProjection {
  return {
    currentOperationalState: operationalItems.filter(
      (item) => item.workflowState !== "RESOLVED"
    ),

    hostActionQueue: operationalItems.filter(
      (item) =>
        item.workflowState === "ACTION_REQUIRED" &&
        item.visibility === "HOST" &&
        item.actionRequired === true
    ),

    waitingItems: operationalItems.filter(
      (item) => item.workflowState === "WAITING"
    ),

    autoResolvingItems: operationalItems.filter(
      (item) => item.workflowState === "AUTO_RESOLVING"
    ),

    recentlyResolved: operationalItems.filter(
      (item) => item.workflowState === "RESOLVED"
    ),
  };
}

function asDate(value: Date | string | null | undefined) {
  if (value instanceof Date) {
    return value;
  }

  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? undefined
    : parsed;
}

function getOperationalTimestamp(
  item: MissionControlOperationalItem
) {
  return (
    asDate(item.lastSignalAt)?.getTime() ??
    asDate(item.firstDetectedAt)?.getTime() ??
    0
  );
}

/**
 * E12 current-state cutover.
 *
 * Current autopilot/engine health is derived exclusively from unresolved
 * OperationalIssue projections. ApmsAuditEntry is historical evidence and
 * must not revive a resolved issue or keep Mission Control in a stale warning
 * state.
 */
export function deriveMissionControlCurrentStateSummary(
  currentOperationalState: readonly MissionControlOperationalItem[]
): MissionControlCurrentStateSummary {
  const activeItems = currentOperationalState.filter(
    (item) => item.workflowState !== "RESOLVED"
  );

  const hasCritical = activeItems.some(
    (item) => item.severity === "CRITICAL"
  );
  const hasHostAction = activeItems.some(
    (item) =>
      item.workflowState === "ACTION_REQUIRED" &&
      item.visibility === "HOST" &&
      item.actionRequired === true
  );

  const autopilotStatus: AutopilotStatus = hasCritical
    ? "ERROR"
    : hasHostAction
    ? "NEEDS_ATTENTION"
    : "ACTIVE";

  const byEngine = new Map<
    string,
    MissionControlOperationalItem[]
  >();

  for (const item of activeItems) {
    const engine = String(item.engine ?? "").trim();
    if (!engine) {
      continue;
    }

    const entries = byEngine.get(engine) ?? [];
    entries.push(item);
    byEngine.set(engine, entries);
  }

  const engineHealth: EngineHealth[] = Array.from(
    byEngine.entries()
  )
    .map(([engine, entries]) => {
      const ordered = [...entries].sort(
        (left, right) =>
          getOperationalTimestamp(right) -
          getOperationalTimestamp(left)
      );
      const latest = ordered[0];
      const critical = entries.some(
        (item) => item.severity === "CRITICAL"
      );
      const lastExecutionAt =
        asDate(latest?.lastSignalAt) ??
        asDate(latest?.firstDetectedAt);
      const message =
        latest?.operationalImpact ??
        latest?.issue ??
        latest?.title;

      const health: EngineHealth = {
        engine,
        status: critical ? "ERROR" : "WARNING",
      };

      if (lastExecutionAt) {
        health.lastExecutionAt = lastExecutionAt;
      }

      if (message) {
        health.message = message;
      }

      return health;
    })
    .sort((left, right) =>
      left.engine.localeCompare(right.engine)
    );

  return {
    autopilotStatus,
    engineHealth,
  };
}

function mapOperationalSeverityToActionPriority(
  severity: MissionControlOperationalItem["severity"]
): MissionControlAction["priority"] {
  if (severity === "CRITICAL") {
    return "CRITICAL";
  }

  if (severity === "WARNING") {
    return "HIGH";
  }

  return "LOW";
}

/**
 * Preserves the legacy recommendedActions response contract while deriving
 * every host action exclusively from the canonical OperationalIssue current
 * state projection.
 */
export function mapHostActionQueueToRecommendedActions(
  hostActionQueue: readonly MissionControlOperationalItem[]
): MissionControlAction[] {
  if (hostActionQueue.length === 0) {
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

  return hostActionQueue.map((item) => ({
    title: item.title,
    description:
      item.operationalImpact ??
      item.issue,
    engine: item.engine,
    priority:
      mapOperationalSeverityToActionPriority(
        item.severity
      ),
    requiresHumanAction: true,
    reservationId:
      item.reservationId ?? null,
    reservationNumber:
      item.reservationNumber ?? null,
    guestName:
      item.guestName ?? null,
    issue:
      item.issue ?? null,
    lastSignalAt:
      item.lastSignalAt ?? null,
    recommendedAction:
      item.recommendedAction ?? null,
    canAutoResolve:
      item.canAutoResolve,
  }));
}
