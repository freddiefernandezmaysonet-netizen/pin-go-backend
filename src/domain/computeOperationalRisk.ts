import {
  DeviceHealthStatus,
  OperationalRiskLevel,
} from "@prisma/client";

const GATEWAY_CRITICAL_WINDOW_HOURS = 6;
const BATTERY_WARNING_THRESHOLD = 30;
const BATTERY_CRITICAL_THRESHOLD = 20;

type ComputeOperationalRiskInput = {
  healthStatus: DeviceHealthStatus;
  battery?: number | null;
  gatewayConnected?: boolean | null;
  lastSeenAt?: Date | null;
  nextCheckInAt?: Date | null;
  hasActiveAccess?: boolean | null;
};

type ComputeOperationalRiskOutput = {
  operationalRisk: OperationalRiskLevel;
  operationalMessage: string;
  recommendedAction: string;
};

export function computeOperationalRisk(
  input: ComputeOperationalRiskInput
): ComputeOperationalRiskOutput {
  const {
    healthStatus,
    battery,
    gatewayConnected,
    lastSeenAt,
    nextCheckInAt,
  } = input;

  const now = Date.now();

  const hoursToCheckIn =
    nextCheckInAt != null
      ? (nextCheckInAt.getTime() - now) / (1000 * 60 * 60)
      : null;

  const checkInSoon =
    hoursToCheckIn !== null &&
    hoursToCheckIn >= 0 &&
    hoursToCheckIn <= 24;

  const gatewayCriticalWindow =
    hoursToCheckIn !== null &&
    hoursToCheckIn >= 0 &&
    hoursToCheckIn <= GATEWAY_CRITICAL_WINDOW_HOURS;

  // ==================================================
  // UNKNOWN / MISSING VALIDATION
  // ==================================================
  if (!lastSeenAt) {
    return {
      operationalRisk: "UNKNOWN",
      operationalMessage: "No telemetry available for this lock.",
      recommendedAction:
        "Run device validation and verify TTLock connectivity.",
    };
  }

  if (healthStatus === "UNKNOWN") {
    return {
      operationalRisk: "UNKNOWN",
      operationalMessage:
        "Pin&Go could not validate this lock from TTLock.",
      recommendedAction:
        "Verify TTLock access, gateway status, and lock connectivity.",
    };
  }

  if (gatewayConnected == null) {
    return {
      operationalRisk: "UNKNOWN",
      operationalMessage:
        "Gateway status is unknown. Pin&Go could not confirm remote readiness.",
      recommendedAction:
        "Revalidate this lock and confirm gateway connectivity.",
    };
  }

  // ==================================================
  // CRITICAL CONDITIONS
  // ==================================================
  if (gatewayConnected === false && gatewayCriticalWindow) {
    return {
      operationalRisk: "CRITICAL",
      operationalMessage:
        "Gateway unavailable six hours before check-in. Immediate action is required.",
      recommendedAction:
        "Restore gateway connectivity before guest arrival.",
    };
  }

  if (
    battery !== null &&
    battery < BATTERY_CRITICAL_THRESHOLD &&
    checkInSoon
  ) {
    return {
      operationalRisk: "CRITICAL",
      operationalMessage:
        `Battery is below ${BATTERY_CRITICAL_THRESHOLD}% before an upcoming check-in.`,
      recommendedAction:
        "Replace the lock batteries before guest arrival.",
    };
  }

  if (healthStatus === "OFFLINE" && checkInSoon) {
    return {
      operationalRisk: "CRITICAL",
      operationalMessage:
        "Lock is offline and a reservation is approaching.",
      recommendedAction:
        "Inspect the lock immediately and restore connectivity.",
    };
  }

  // ==================================================
  // AT RISK CONDITIONS
  // ==================================================
  if (healthStatus === "OFFLINE") {
    return {
      operationalRisk: "AT_RISK",
      operationalMessage:
        "Lock appears offline. Future operations may fail.",
      recommendedAction:
        "Check lock connectivity and verify gateway status.",
    };
  }

  // ==================================================
  // WARNING CONDITIONS
  // ==================================================
  if (gatewayConnected === false) {
    return {
      operationalRisk: "WARNING",
      operationalMessage:
        "Gateway unavailable. Pin&Go will escalate if it remains offline inside six hours of check-in.",
      recommendedAction:
        "Verify gateway connectivity before the next guest arrival.",
    };
  }

  if (
    battery !== null &&
    battery < BATTERY_WARNING_THRESHOLD
  ) {
    return {
      operationalRisk: "WARNING",
      operationalMessage:
        `Battery below ${BATTERY_WARNING_THRESHOLD}%. Replacement recommended soon.`,
      recommendedAction:
        "Schedule battery replacement to avoid future access issues.",
    };
  }

  if (healthStatus === "WARNING" || healthStatus === "LOW_BATTERY") {
    return {
      operationalRisk: "WARNING",
      operationalMessage:
        "This lock requires preventive attention before it becomes a guest issue.",
      recommendedAction:
        "Review lock status and complete preventive maintenance.",
    };
  }

  // ==================================================
  // HEALTHY
  // ==================================================
  return {
    operationalRisk: "HEALTHY",
    operationalMessage: "Lock is ready for normal operation.",
    recommendedAction: "No action required.",
  };
}
