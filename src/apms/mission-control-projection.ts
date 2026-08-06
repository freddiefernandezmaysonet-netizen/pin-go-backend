import type {
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