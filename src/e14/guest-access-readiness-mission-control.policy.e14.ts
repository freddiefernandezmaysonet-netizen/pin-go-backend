import {
  GUEST_ACCESS_PROVISION_OPERATION,
  parseGuestAccessProvisionFenceState,
} from "./guest-access-admission-fence.policy.e14.js";

export const GUEST_ACCESS_READINESS_ISSUE_CODE =
  "GUEST_ACCESS_READINESS_PENDING";
export const GUEST_ACCESS_RECOVERY_ISSUE_CODE =
  "GUEST_ACCESS_PROVISIONING_RECOVERY";
export const GUEST_ACCESS_AMBIGUITY_ISSUE_CODE =
  "GUEST_ACCESS_PROVISIONING_REVIEW_REQUIRED";

export type GuestAccessMissionSnapshot = {
  reservationId: string;
  reservationNumber: string | null;
  guestName: string | null;
  organizationId: string;
  propertyId: string;
  status: string;
  guestAccessReleaseStatus: string;
  checkIn: Date;
  checkOut: Date;
  accessGrants: Array<{
    status: string;
    providerCredentialPresent: boolean;
    secureCodePresent: boolean;
    recoveryOperation: string | null;
    recoveryNextAttemptAt: Date | null;
    recoveryExhaustedAt: Date | null;
  }>;
};

export type GuestAccessIssueProjection =
  | {
      active: false;
      operationalKey: string;
      issueCode: string;
      resolutionCode: string;
      resolutionSummary: string;
      resolutionType: "AUTOMATIC" | "EXPIRED" | "SUPERSEDED";
    }
  | {
      active: true;
      operationalKey: string;
      issueCode: string;
      title: string;
      issue: string;
      operationalImpact: string;
      recommendedAction: string | null;
      nextAutomaticStep: string | null;
      severity: "INFO" | "WARNING" | "CRITICAL";
      workflowState:
        | "WAITING"
        | "AUTO_RESOLVING"
        | "ACTION_REQUIRED";
      visibility: "HOST" | "SYSTEM" | "DEVELOPER";
      responsibleActor:
        | "GUEST"
        | "HOST"
        | "PIN_GO"
        | "SYSTEM";
      actionRequired: boolean;
      canAutoResolve: true;
      autoResolveStatus: "AVAILABLE";
      metadata: Record<string, unknown>;
    };

function noLongerApplicable(
  snapshot: GuestAccessMissionSnapshot,
  now: Date
) {
  return (
    snapshot.status !== "ACTIVE" ||
    snapshot.checkOut.getTime() <= now.getTime()
  );
}

function hasActiveGrant(
  snapshot: GuestAccessMissionSnapshot
) {
  return snapshot.accessGrants.some(
    (grant) =>
      grant.status === "ACTIVE" &&
      grant.providerCredentialPresent &&
      grant.secureCodePresent
  );
}

export function projectGuestAccessReadinessIssue(
  snapshot: GuestAccessMissionSnapshot,
  input: {
    now?: Date;
    hostActionLeadMs?: number;
  } = {}
): GuestAccessIssueProjection {
  const now = input.now ?? new Date();
  const hostActionLeadMs =
    input.hostActionLeadMs ?? 2 * 60 * 60_000;
  const operationalKey =
    `GUEST_ACCESS_READINESS:${snapshot.reservationId}`;

  if (
    noLongerApplicable(snapshot, now) ||
    hasActiveGrant(snapshot) ||
    ["ELIGIBLE", "RELEASED"].includes(
      snapshot.guestAccessReleaseStatus
    )
  ) {
    return {
      active: false,
      operationalKey,
      issueCode: GUEST_ACCESS_READINESS_ISSUE_CODE,
      resolutionCode:
        noLongerApplicable(snapshot, now)
          ? "GUEST_ACCESS_READINESS_NO_LONGER_APPLICABLE"
          : "GUEST_ACCESS_READINESS_SATISFIED",
      resolutionSummary:
        "The guest access readiness condition no longer requires operational attention.",
      resolutionType:
        noLongerApplicable(snapshot, now)
          ? snapshot.status === "ACTIVE"
            ? "EXPIRED"
            : "SUPERSEDED"
          : "AUTOMATIC",
    };
  }

  const hostActionRequired =
    snapshot.checkIn.getTime() <=
    now.getTime() + hostActionLeadMs;

  return {
    active: true,
    operationalKey,
    issueCode: GUEST_ACCESS_READINESS_ISSUE_CODE,
    title: hostActionRequired
      ? "Guest pre-arrival requirements need attention"
      : "Waiting for guest pre-arrival requirements",
    issue: hostActionRequired
      ? "Required pre-arrival steps are incomplete near the access window."
      : "Pin&Go is waiting for the guest to complete required pre-arrival steps.",
    operationalImpact:
      "Guest access will remain securely blocked until the required evidence is complete.",
    recommendedAction: hostActionRequired
      ? "Contact the guest and ask them to complete the secure pre-arrival process before check-in."
      : null,
    nextAutomaticStep: hostActionRequired
      ? null
      : "Pin&Go will re-evaluate access automatically when new guest evidence is received.",
    severity: hostActionRequired
      ? "WARNING"
      : "INFO",
    workflowState: hostActionRequired
      ? "ACTION_REQUIRED"
      : "WAITING",
    visibility: "HOST",
    responsibleActor: hostActionRequired
      ? "HOST"
      : "GUEST",
    actionRequired: hostActionRequired,
    canAutoResolve: true,
    autoResolveStatus: "AVAILABLE",
    metadata: {
      contractVersion:
        "guest_access_readiness_mission_control_e14_v1",
      reservationId: snapshot.reservationId,
      propertyId: snapshot.propertyId,
      stage: "PRE_ARRIVAL_REQUIREMENTS",
      releaseStatus:
        snapshot.guestAccessReleaseStatus,
      checkIn: snapshot.checkIn.toISOString(),
      checkOut: snapshot.checkOut.toISOString(),
      sanitized: true,
    },
  };
}

export function projectGuestAccessRecoveryIssue(
  snapshot: GuestAccessMissionSnapshot,
  input: { now?: Date } = {}
): GuestAccessIssueProjection {
  const now = input.now ?? new Date();
  const operationalKey =
    `GUEST_ACCESS_PROVISIONING_RECOVERY:${snapshot.reservationId}`;
  const recoveryGrants = snapshot.accessGrants.filter(
    (grant) => {
      const state =
        parseGuestAccessProvisionFenceState(
          grant.recoveryOperation
        );
      return (
        grant.status === "PENDING" &&
        [
          "RETRYABLE",
          "CLAIMED",
          "EXECUTING",
        ].includes(state)
      );
    }
  );

  if (
    recoveryGrants.length === 0 ||
    noLongerApplicable(snapshot, now) ||
    hasActiveGrant(snapshot)
  ) {
    return {
      active: false,
      operationalKey,
      issueCode:
        GUEST_ACCESS_RECOVERY_ISSUE_CODE,
      resolutionCode:
        noLongerApplicable(snapshot, now)
          ? "GUEST_ACCESS_PROVISIONING_RECOVERY_NO_LONGER_APPLICABLE"
          : "GUEST_ACCESS_PROVISIONING_RECOVERED",
      resolutionSummary:
        "The automatic guest access recovery workflow no longer requires monitoring.",
      resolutionType:
        noLongerApplicable(snapshot, now)
          ? snapshot.status === "ACTIVE"
            ? "EXPIRED"
            : "SUPERSEDED"
          : "AUTOMATIC",
    };
  }

  const states = Array.from(
    new Set(
      recoveryGrants.map((grant) =>
        parseGuestAccessProvisionFenceState(
          grant.recoveryOperation
        )
      )
    )
  ).sort();
  const nextAutomaticAt = recoveryGrants
    .map((grant) => grant.recoveryNextAttemptAt)
    .filter((value): value is Date =>
      value instanceof Date
    )
    .sort(
      (left, right) =>
        left.getTime() - right.getTime()
    )[0] ?? null;

  return {
    active: true,
    operationalKey,
    issueCode: GUEST_ACCESS_RECOVERY_ISSUE_CODE,
    title: "Guest access is being recovered automatically",
    issue:
      "Pin&Go fenced the access operation and is following its bounded recovery workflow.",
    operationalImpact:
      "Automatic execution remains serialized while Pin&Go retries or verifies the current access outcome.",
    recommendedAction: null,
    nextAutomaticStep:
      "Pin&Go will continue the fenced recovery workflow without replaying uncertain physical operations.",
    severity: "WARNING",
    workflowState: "AUTO_RESOLVING",
    visibility: "SYSTEM",
    responsibleActor: "PIN_GO",
    actionRequired: false,
    canAutoResolve: true,
    autoResolveStatus: "AVAILABLE",
    metadata: {
      contractVersion:
        "guest_access_readiness_mission_control_e14_v1",
      reservationId: snapshot.reservationId,
      propertyId: snapshot.propertyId,
      stage: "ACCESS_PROVISIONING_RECOVERY",
      fenceStates: states,
      nextAutomaticAt:
        nextAutomaticAt?.toISOString() ?? null,
      sanitized: true,
    },
  };
}

export function projectGuestAccessAmbiguityIssue(
  snapshot: GuestAccessMissionSnapshot,
  input: { now?: Date } = {}
): GuestAccessIssueProjection {
  const now = input.now ?? new Date();
  const operationalKey =
    `GUEST_ACCESS_PROVISIONING_AMBIGUOUS:${snapshot.reservationId}`;
  const reviewRequired = snapshot.accessGrants.some(
    (grant) => {
      const state =
        parseGuestAccessProvisionFenceState(
          grant.recoveryOperation
        );

      return (
        grant.recoveryOperation ===
          GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS ||
        state === "AMBIGUOUS" ||
        state === "EXHAUSTED" ||
        (state === "OTHER_OPERATION" &&
          grant.status === "PENDING")
      );
    }
  );

  if (
    !reviewRequired ||
    noLongerApplicable(snapshot, now)
  ) {
    return {
      active: false,
      operationalKey,
      issueCode: GUEST_ACCESS_AMBIGUITY_ISSUE_CODE,
      resolutionCode:
        noLongerApplicable(snapshot, now)
          ? "GUEST_ACCESS_PROVISIONING_NO_LONGER_APPLICABLE"
          : "GUEST_ACCESS_PROVISIONING_RECONCILED",
      resolutionSummary:
        "The uncertain guest access execution no longer requires reconciliation.",
      resolutionType:
        noLongerApplicable(snapshot, now)
          ? snapshot.status === "ACTIVE"
            ? "EXPIRED"
            : "SUPERSEDED"
          : "AUTOMATIC",
    };
  }

  return {
    active: true,
    operationalKey,
    issueCode: GUEST_ACCESS_AMBIGUITY_ISSUE_CODE,
    title: "Guest access execution requires reconciliation",
    issue:
      "Pin&Go stopped automatic replay because the result of an access execution is uncertain.",
    operationalImpact:
      "Automatic replay is fenced to prevent duplicate or conflicting physical credentials.",
    recommendedAction:
      "Reconcile the durable access evidence before rearming provisioning.",
    nextAutomaticStep: null,
    severity: "CRITICAL",
    workflowState: "ACTION_REQUIRED",
    visibility: "DEVELOPER",
    responsibleActor: "SYSTEM",
    actionRequired: true,
    canAutoResolve: true,
    autoResolveStatus: "AVAILABLE",
    metadata: {
      contractVersion:
        "guest_access_readiness_mission_control_e14_v1",
      reservationId: snapshot.reservationId,
      propertyId: snapshot.propertyId,
      stage: "ACCESS_EXECUTION_RECONCILIATION",
      sanitized: true,
    },
  };
}

export type GuestAccessSafetyEvaluationSnapshot = {
  status: string;
  checkOut: Date;
  guestAccessReleaseStatus: string;
  guestAccessReleaseLastError: string | null;
};

/**
 * Event producers remain authoritative. The safety cycle only bootstraps
 * legacy/uninitialized rows once; a persisted blocker waits for new evidence
 * instead of being rewritten every minute.
 */
export function shouldRunGuestAccessReadinessSafetyEvaluation(
  snapshot: GuestAccessSafetyEvaluationSnapshot,
  now: Date
): boolean {
  return (
    snapshot.status === "ACTIVE" &&
    snapshot.checkOut.getTime() > now.getTime() &&
    !["ELIGIBLE", "RELEASED"].includes(
      snapshot.guestAccessReleaseStatus
    ) &&
    !snapshot.guestAccessReleaseLastError
  );
}

export const GUEST_ACCESS_OPERATIONAL_SIGNAL_REFRESH_MS =
  5 * 60_000;

export function shouldPersistGuestAccessOperationalSignal(
  input: {
    existingWorkflowState: string | null;
    existingLastSignalAt: Date | null;
    nextWorkflowState: string;
    now: Date;
    refreshMs?: number;
  }
): boolean {
  if (!input.existingWorkflowState) return true;
  if (
    input.existingWorkflowState !==
    input.nextWorkflowState
  ) {
    return true;
  }
  if (!input.existingLastSignalAt) return true;

  const refreshMs =
    input.refreshMs ??
    GUEST_ACCESS_OPERATIONAL_SIGNAL_REFRESH_MS;

  return (
    input.now.getTime() -
      input.existingLastSignalAt.getTime() >=
    refreshMs
  );
}
