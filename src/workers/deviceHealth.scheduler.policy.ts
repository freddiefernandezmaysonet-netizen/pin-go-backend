import type { GatewayMonitoringMode } from "../services/lockGatewayMonitoring.service";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Used only for low-frequency recovery checks after a persistent gateway
// failure has already escalated. Healthy gateways are reservation-driven.
export const GATEWAY_HEALTHY_INTERVAL_MS = DAY_MS;
export const GATEWAY_FIRST_RETRY_MS = 8 * HOUR_MS;
export const GATEWAY_SECOND_RETRY_MS = 12 * HOUR_MS;
export const GATEWAY_READINESS_WINDOW_MS = 6 * HOUR_MS;

export type SchedulerHealth = {
  battery: number | null;
  batteryLastCheckedAt: Date | null;
  batteryNextCheckAt: Date | null;
  gatewayConnected: boolean | null;
  gatewayLastCheckedAt: Date | null;
  gatewayLastSuccessfulAt: Date | null;
  gatewayNextCheckAt: Date | null;
  gatewayDisconnectedSince: Date | null;
  gatewayCheckReservationId: string | null;
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
  reservationId?: string | null;
  checkIn?: Date | null;
}) {
  if (input.mode === "DISABLED") {
    return false;
  }

  // Gateway readiness is intentionally quiet until the next ACTIVE arrival is
  // inside the six-hour critical window. Configuration-time verification is a
  // separate one-time action and is not governed by this worker scheduler.
  if (!input.checkIn || !input.reservationId) {
    return false;
  }

  const readinessWindowStart = new Date(
    input.checkIn.getTime() - GATEWAY_READINESS_WINDOW_MS
  );

  if (input.now < readinessWindowStart) {
    return false;
  }

  const health = input.health;

  if (!health?.gatewayLastCheckedAt) {
    return true;
  }

  const sameReservation =
    health.gatewayCheckReservationId === input.reservationId;

  const checkedInsideReadinessWindow =
    sameReservation &&
    health.gatewayLastCheckedAt >= readinessWindowStart;

  // Every reservation gets its own fresh T-6 readiness certification. Older
  // telemetry, including a healthy result from another reservation, cannot
  // satisfy the current arrival.
  if (!checkedInsideReadinessWindow) {
    return true;
  }

  const certifiedHealthyForArrival =
    health.gatewayConnected === true &&
    health.gatewayLastSuccessfulAt !== null &&
    health.gatewayLastSuccessfulAt >= readinessWindowStart;

  // One successful verification inside T-6 certifies the gateway for this
  // reservation. Do not spend more TTLock calls while the gateway remains healthy.
  if (certifiedHealthyForArrival) {
    return false;
  }

  // A failed/provider-error check inside T-6 keeps its recovery timer
  // authoritative. Failures retry hourly so Pin&Go can auto-resolve if the host
  // restores connectivity before check-in.
  if (health.gatewayNextCheckAt) {
    return health.gatewayNextCheckAt <= input.now;
  }

  return true;
}

export function nextGatewaySuccessCheckAt(input: {
  now: Date;
  mode: GatewayMonitoringMode;
  checkIn?: Date | null;
}) {
  // A successful gateway check is terminal for the current reservation's
  // readiness window. The next reservation requires its own T-6 certification.
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
    // Kept for maintenance callers outside reservation readiness. The worker's
    // gateway scheduler itself stays quiet while no reservation is inside T-6.
    nextCheckAt: new Date(
      input.now.getTime() + GATEWAY_HEALTHY_INTERVAL_MS
    ),
    stage: "ACTION_REQUIRED" as const,
  };
}
