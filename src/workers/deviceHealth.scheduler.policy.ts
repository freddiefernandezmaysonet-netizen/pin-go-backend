import type { GatewayMonitoringMode } from "../services/lockGatewayMonitoring.service";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const GATEWAY_HEALTHY_INTERVAL_MS = DAY_MS;
export const GATEWAY_FIRST_RETRY_MS = 8 * HOUR_MS;
export const GATEWAY_SECOND_RETRY_MS = 12 * HOUR_MS;

export type SchedulerHealth = {
  battery: number | null;
  batteryLastCheckedAt: Date | null;
  batteryNextCheckAt: Date | null;
  gatewayConnected: boolean | null;
  gatewayLastCheckedAt: Date | null;
  gatewayLastSuccessfulAt: Date | null;
  gatewayNextCheckAt: Date | null;
  gatewayDisconnectedSince: Date | null;
};

export function isBatteryCheckDue(input: {
  now: Date;
  health: SchedulerHealth | null;
}) {
  const health = input.health;

  if (!health) return true;

  // Once a next-check timestamp exists it is authoritative. In particular,
  // battery=null after a provider failure must not cause an hourly retry.
  if (health.batteryNextCheckAt) {
    return health.batteryNextCheckAt <= input.now;
  }

  return !health.batteryLastCheckedAt;
}

export function reservationGatewayIntervalMs(input: {
  now: Date;
  checkIn: Date;
}) {
  const hoursToCheckIn =
    (input.checkIn.getTime() - input.now.getTime()) /
    HOUR_MS;

  if (hoursToCheckIn <= 6) return HOUR_MS;
  if (hoursToCheckIn <= 12) return 2 * HOUR_MS;
  return 4 * HOUR_MS;
}

export function isGatewayCheckDue(input: {
  now: Date;
  mode: GatewayMonitoringMode;
  health: SchedulerHealth | null;
  checkIn?: Date | null;
}) {
  if (input.mode === "DISABLED") {
    return false;
  }

  const health = input.health;

  if (health?.gatewayNextCheckAt) {
    return health.gatewayNextCheckAt <= input.now;
  }

  if (!health?.gatewayLastCheckedAt) {
    // Legacy unconfigured locks preserve the previous behavior: gateway is
    // checked only when there is an operational reservation window.
    return input.mode === "ENABLED" || Boolean(input.checkIn);
  }

  if (input.checkIn) {
    const interval = reservationGatewayIntervalMs({
      now: input.now,
      checkIn: input.checkIn,
    });

    return (
      input.now.getTime() -
        health.gatewayLastCheckedAt.getTime() >=
      interval
    );
  }

  if (input.mode === "LEGACY_UNCONFIGURED") {
    return false;
  }

  return (
    input.now.getTime() -
      health.gatewayLastCheckedAt.getTime() >=
    GATEWAY_HEALTHY_INTERVAL_MS
  );
}

export function nextGatewaySuccessCheckAt(input: {
  now: Date;
  mode: GatewayMonitoringMode;
  checkIn?: Date | null;
}) {
  if (input.checkIn) {
    return new Date(
      input.now.getTime() +
        reservationGatewayIntervalMs({
          now: input.now,
          checkIn: input.checkIn,
        })
    );
  }

  if (input.mode === "ENABLED") {
    return new Date(
      input.now.getTime() + GATEWAY_HEALTHY_INTERVAL_MS
    );
  }

  return null;
}

export function nextGatewayFailure(input: {
  now: Date;
  disconnectedSince: Date | null;
  checkIn?: Date | null;
}) {
  if (input.checkIn) {
    return {
      escalate: false,
      nextCheckAt: new Date(
        input.now.getTime() +
          reservationGatewayIntervalMs({
            now: input.now,
            checkIn: input.checkIn,
          })
      ),
      stage: "RESERVATION_RETRY" as const,
    };
  }

  if (!input.disconnectedSince) {
    return {
      escalate: false,
      nextCheckAt: new Date(
        input.now.getTime() + GATEWAY_FIRST_RETRY_MS
      ),
      stage: "FIRST_RETRY" as const,
    };
  }

  const elapsed =
    input.now.getTime() - input.disconnectedSince.getTime();

  if (elapsed < GATEWAY_FIRST_RETRY_MS) {
    return {
      escalate: false,
      nextCheckAt: new Date(
        input.disconnectedSince.getTime() +
          GATEWAY_FIRST_RETRY_MS
      ),
      stage: "FIRST_RETRY" as const,
    };
  }

  if (
    elapsed <
    GATEWAY_FIRST_RETRY_MS + GATEWAY_SECOND_RETRY_MS
  ) {
    return {
      escalate: false,
      nextCheckAt: new Date(
        input.now.getTime() + GATEWAY_SECOND_RETRY_MS
      ),
      stage: "SECOND_RETRY" as const,
    };
  }

  return {
    escalate: true,
    // Once host action is required, keep one low-frequency automatic recovery
    // check per day so Pin&Go can auto-resolve when connectivity returns.
    nextCheckAt: new Date(
      input.now.getTime() + GATEWAY_HEALTHY_INTERVAL_MS
    ),
    stage: "ACTION_REQUIRED" as const,
  };
}
