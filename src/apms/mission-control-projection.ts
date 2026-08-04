import type {
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