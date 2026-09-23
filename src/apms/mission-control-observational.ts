/**
 * Host reporting is observational until legacy engine health is independently
 * verified. Enterprise rollout status and historical audit success are NOT
 * evidence that every property engine is active, paused or healthy.
 *
 * Explicit nulls preserve the response keys without asserting a global health
 * verdict. Operational alerts, Guest Journey progress and history pass through
 * unchanged. This function never changes execution authority or stored data.
 */
export function toObservationalMissionControlSnapshot<T extends {
  autopilotStatus: unknown;
  engineHealth: unknown;
}>(snapshot: T): Omit<T, "autopilotStatus" | "engineHealth"> & {
  autopilotStatus: null;
  engineHealth: null;
} {
  return {
    ...snapshot,
    autopilotStatus: null,
    engineHealth: null,
  };
}
