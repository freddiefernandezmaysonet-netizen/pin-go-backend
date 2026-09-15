import type { GatewayMonitoringMode } from "../services/lockGatewayMonitoring.service";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Used only for low-frequency recovery checks after a persistent gateway
// failure has already escalated. Healthy gateways are reservation-driven.
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

  // Only failure/revalidation timers are authoritative while idle. This also
  // prevents a legacy +24h healthy timer written by the previous policy from
  // causing one last unnecessary maintenance call after this rollout.
  if (
    health?.gatewayDisconnectedSince &&
    health.gatewayNextCheckAt
  ) {
    return health.gatewayNextCheckAt <= input.now;
  }

  // Healthy gateways do not receive maintenance polling while the property is
  // idle. Once a reservation enters the worker's 24-hour window, readiness
  // checks resume and accelerate as check-in approaches.
  if (!input.checkIn) {
    return false;
  }

  if (!health?.gatewayLastCheckedAt) {
    return true;
  }

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

  // A confirmed healthy gateway stays quiet while there is no reservation in
  // the 24-hour readiness window. The hourly worker can still notice when a
  // new reservation enters that window without making TTLock calls while idle.
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
