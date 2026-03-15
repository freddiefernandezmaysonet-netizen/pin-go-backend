import {
  DeviceHealthStatus,
  OperationalRiskLevel,
} from "@prisma/client";

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

  const checkInSoon = hoursToCheckIn !== null && hoursToCheckIn <= 24;

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
  if (gatewayConnected === false && checkInSoon) {
    return {
      operationalRisk: "CRITICAL",
      operationalMessage:
        "Gateway unavailable and a reservation is scheduled soon. Pin&Go may fail to prepare access before guest arrival.",
      recommendedAction:
        "Verify gateway connectivity immediately and restore remote communication.",
    };
  }

  if (battery !== null && battery < 30 && checkInSoon) {
    return {
      operationalRisk: "CRITICAL",
      operationalMessage:
        "Battery below 30% and a reservation is scheduled soon. Replace batteries immediately to avoid reservation issues.",
      recommendedAction:
        "Replace lock batteries before the next check-in.",
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
        "Gateway unavailable. Pin&Go remote preparation may fail for this lock.",
      recommendedAction:
        "Verify gateway installation and restore connectivity.",
    };
  }

  if (battery !== null && battery < 30) {
    return {
      operationalRisk: "WARNING",
      operationalMessage:
        "Battery below 30%. Replacement recommended soon.",
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