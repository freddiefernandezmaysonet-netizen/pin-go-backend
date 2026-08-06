import { createHash } from "node:crypto";

import {
  AccessMethod,
  AccessStatus,
  GuestAccessReleaseStatus,
  GuestJourneyState,
  PaymentState,
  ReservationStatus,
} from "@prisma/client";

import {
  CANONICAL_GUEST_JOURNEY_EVALUATOR_VERSION,
  GUEST_JOURNEY_EVIDENCE_CONTRACT_VERSION,
  getCanonicalGuestJourneyStateRank,
  isTerminalGuestJourneyState,
} from "./guest-journey-contract";

import type {
  CanonicalJourneyEvaluation,
  GuestJourneyBlocker,
  GuestJourneyBlockerCode,
  GuestJourneyCoordinationIntentType,
  GuestJourneyEvidenceSnapshot,
  GuestJourneyInconsistency,
  GuestJourneyInconsistencyCode,
  GuestJourneyInternalRepair,
  GuestJourneyTemporalPhase,
  ProposedJourneyCoordinationIntent,
} from "./guest-journey-contract";

/**
 * Canonical Journey Evaluator V1.
 *
 * Pure and deterministic:
 * - no Prisma access;
 * - no writes;
 * - no external providers;
 * - no communication delivery;
 * - no Access execution;
 * - no Mission Control mutation.
 */

const ARRIVAL_WINDOW_MS =
  2 * 60 * 60 * 1000;

const ACTIVE_INTENT_STATUSES = new Set([
  "PENDING",
  "CLAIMED",
  "WAITING_FOR_EVIDENCE",
  "RETRYABLE",
]);

function stableNormalize(
  value: unknown
): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(stableNormalize);
  }

  if (
    value &&
    typeof value === "object"
  ) {
    const result:
      Record<string, unknown> = {};

    for (
      const key of
      Object.keys(
        value as Record<string, unknown>
      ).sort()
    ) {
      result[key] = stableNormalize(
        (
          value as Record<string, unknown>
        )[key]
      );
    }

    return result;
  }

  return value;
}

function hashStableValue(
  value: unknown
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        stableNormalize(value)
      )
    )
    .digest("hex");
}

function buildEvidenceFingerprint(
  evidence: GuestJourneyEvidenceSnapshot,
  temporalPhase: GuestJourneyTemporalPhase
): string {
  const communicationSignals =
    [...evidence.communications.signals]
      .map((signal) => ({
        communicationType:
          signal.communicationType,
        channel: signal.channel,
        status: signal.status,
        retryCount: signal.retryCount,
        lastError: signal.lastError,
      }))
      .sort((first, second) =>
        [
          first.communicationType,
          first.channel,
          first.status,
          String(first.retryCount),
        ]
          .join(":")
          .localeCompare(
            [
              second.communicationType,
              second.channel,
              second.status,
              String(second.retryCount),
            ].join(":")
          )
      );

  return hashStableValue({
    contractVersion:
      evidence.contractVersion,

    temporalPhase,

    reservation:
      evidence.reservation,

    requirements:
      evidence.requirements,

    verification:
      evidence.verification,

    access:
      evidence.access,

    communications: {
      signals: communicationSignals,
    },
  });
}

function determineTemporalPhase(
  evidence: GuestJourneyEvidenceSnapshot
): GuestJourneyTemporalPhase {
  const nowMs =
    evidence.evaluatedAt.getTime();

  const checkInMs =
    evidence.reservation.checkIn.getTime();

  const checkOutMs =
    evidence.reservation.checkOut.getTime();

  if (nowMs >= checkOutMs) {
    return "POST_CHECKOUT";
  }

  if (nowMs >= checkInMs) {
    return "IN_STAY";
  }

  if (
    nowMs >=
    checkInMs - ARRIVAL_WINDOW_MS
  ) {
    return "ARRIVAL_WINDOW";
  }

  return "PRE_ARRIVAL";
}

function determineComparison(input: {
  persistedState:
    | GuestJourneyState
    | null;
  expectedState:
    GuestJourneyState;
}) {
  const {
    persistedState,
    expectedState,
  } = input;

  if (!persistedState) {
    return "MISSING" as const;
  }

  if (
    persistedState === expectedState
  ) {
    return "ALIGNED" as const;
  }

  if (
    isTerminalGuestJourneyState(
      persistedState
    )
  ) {
    return "TERMINAL_CONTRADICTION" as const;
  }

  if (
    expectedState ===
    GuestJourneyState.JOURNEY_CANCELLED
  ) {
    return "BEHIND" as const;
  }

  const persistedRank =
    getCanonicalGuestJourneyStateRank(
      persistedState
    );

  const expectedRank =
    getCanonicalGuestJourneyStateRank(
      expectedState
    );

  if (
    persistedRank === null ||
    expectedRank === null
  ) {
    return "TERMINAL_CONTRADICTION" as const;
  }

  if (
    persistedRank < expectedRank
  ) {
    return "BEHIND" as const;
  }

  return "AHEAD_OF_EVIDENCE" as const;
}

function getStateReason(
  state: GuestJourneyState
): {
  code: string;
  reason: string;
} {
  switch (state) {
    case GuestJourneyState
      .RESERVATION_CONFIRMED:
      return {
        code:
          "RESERVATION_CONFIRMED_REQUIREMENTS_NOT_READY",
        reason:
          "The reservation exists, but Pin&Go does not yet have enough evidence to begin or complete guest verification.",
      };

    case GuestJourneyState
      .VERIFICATION_PENDING:
      return {
        code:
          "GUEST_VERIFICATION_REQUIRED",
        reason:
          "The reservation is eligible for the guest verification stage, but the applicable requirements have not all been completed.",
      };

    case GuestJourneyState
      .VERIFICATION_COMPLETED:
      return {
        code:
          "GUEST_REQUIREMENTS_COMPLETED",
        reason:
          "The applicable legal, agreement and identity requirements are satisfied.",
      };

    case GuestJourneyState
      .ACCESS_SCHEDULED:
      return {
        code:
          "GUEST_ACCESS_PROVISIONED",
        reason:
          "Access contains a complete active passcode grant with secure persisted evidence.",
      };

    case GuestJourneyState
      .READY_FOR_ARRIVAL:
      return {
        code:
          "ARRIVAL_WINDOW_OPEN_WITH_VALID_ACCESS",
        reason:
          "The arrival readiness window is open and valid guest access is available.",
      };

    case GuestJourneyState
      .STAY_ACTIVE:
      return {
        code:
          "STAY_WINDOW_ACTIVE_WITH_VALID_ACCESS",
        reason:
          "The scheduled stay window has begun and valid guest access is available.",
      };

    case GuestJourneyState
      .CHECKOUT_DUE:
      return {
        code:
          "CHECKOUT_REACHED_ACCESS_CLOSURE_PENDING",
        reason:
          "The scheduled checkout has been reached, but complete Access closure has not yet been verified.",
      };

    case GuestJourneyState
      .JOURNEY_COMPLETED:
      return {
        code:
          "CHECKOUT_AND_ACCESS_CLOSURE_VERIFIED",
        reason:
          "Checkout was reached and all guest access credentials are persistently closed.",
      };

    case GuestJourneyState
      .JOURNEY_CANCELLED:
      return {
        code:
          "RESERVATION_CANCELLED",
        reason:
          "The reservation is cancelled, so the guest journey is terminally cancelled.",
      };
  }
}

function timestampForState(
  evidence:
    GuestJourneyEvidenceSnapshot,
  state: GuestJourneyState
): Date | null | undefined {
  const journey =
    evidence.persistedJourney;

  switch (state) {
    case GuestJourneyState
      .VERIFICATION_COMPLETED:
      return journey
        .verificationCompletedAt;

    case GuestJourneyState
      .ACCESS_SCHEDULED:
      return journey
        .accessScheduledAt;

    case GuestJourneyState
      .READY_FOR_ARRIVAL:
      return journey
        .readyForArrivalAt;

    case GuestJourneyState
      .STAY_ACTIVE:
      return journey.stayActiveAt;

    case GuestJourneyState
      .CHECKOUT_DUE:
      return journey.checkoutDueAt;

    case GuestJourneyState
      .JOURNEY_COMPLETED:
      return journey.completedAt;

    case GuestJourneyState
      .JOURNEY_CANCELLED:
      return journey.cancelledAt;

    case GuestJourneyState
      .RESERVATION_CONFIRMED:

    case GuestJourneyState
      .VERIFICATION_PENDING:
      return undefined;
  }
}

function uniqueSorted(
  values: string[]
): string[] {
  return [...new Set(values)].sort();
}

export function evaluateCanonicalGuestJourney(
  evidence: GuestJourneyEvidenceSnapshot
): CanonicalJourneyEvaluation {
  if (
    evidence.contractVersion !==
    GUEST_JOURNEY_EVIDENCE_CONTRACT_VERSION
  ) {
    throw new Error(
      `Unsupported Guest Journey evidence contract: ${evidence.contractVersion}`
    );
  }

  const now =
    evidence.evaluatedAt;

  if (
    Number.isNaN(now.getTime())
  ) {
    throw new Error(
      "Guest Journey evidence evaluatedAt is invalid."
    );
  }

  const temporalPhase =
    determineTemporalPhase(evidence);

  const evidenceFingerprint =
    buildEvidenceFingerprint(
      evidence,
      temporalPhase
    );

  const blockersByCode =
    new Map<
      GuestJourneyBlockerCode,
      GuestJourneyBlocker
    >();

  const inconsistenciesByCode =
    new Map<
      GuestJourneyInconsistencyCode,
      GuestJourneyInconsistency
    >();

  const internalRepairs:
    GuestJourneyInternalRepair[] = [];

  const proposedIntents =
    new Map<
      string,
      ProposedJourneyCoordinationIntent
    >();

  const satisfiedRequirements:
    string[] = [];

  const missingRequirements:
    string[] = [];

  const addBlocker = (
    blocker: GuestJourneyBlocker
  ) => {
    if (
      !blockersByCode.has(blocker.code)
    ) {
      blockersByCode.set(
        blocker.code,
        blocker
      );
    }
  };

  const addInconsistency = (
    inconsistency:
      GuestJourneyInconsistency
  ) => {
    if (
      !inconsistenciesByCode.has(
        inconsistency.code
      )
    ) {
      inconsistenciesByCode.set(
        inconsistency.code,
        inconsistency
      );
    }
  };

  const addIntent = (
    intent:
      ProposedJourneyCoordinationIntent
  ) => {
    const matchingActiveIntent =
      evidence.activeIntents.some(
        (existingIntent) =>
          existingIntent.intentType ===
            intent.intentType &&
          existingIntent
            .evidenceFingerprint ===
            evidenceFingerprint &&
          ACTIVE_INTENT_STATUSES.has(
            existingIntent.status
          )
      );

    if (matchingActiveIntent) {
      return;
    }

    const key = [
      intent.intentType,
      intent.targetEngine,
      intent.reasonCode,
      intent.expectedOutcomeCode,
      JSON.stringify(
        stableNormalize(
          intent.payload ?? {}
        )
      ),
    ].join(":");

    proposedIntents.set(
      key,
      intent
    );
  };

  const reservationActive =
    evidence.reservation.status ===
    ReservationStatus.ACTIVE;

  const stayNotEnded =
    evidence.reservation.checkOut
      .getTime() >
    now.getTime();

  const paymentSatisfied =
    evidence.reservation
      .paymentState ===
    PaymentState.PAID;

  const guestTokenValid =
    evidence.reservation
      .guestTokenPresent &&
    Boolean(
      evidence.reservation
        .guestTokenExpiresAt
    ) &&
    evidence.reservation
      .guestTokenExpiresAt!
      .getTime() >
      now.getTime();

  const agreementSnapshotPresent =
    evidence.requirements
      .agreementSnapshotPresent;

  const agreementAcceptancePresent =
    evidence.requirements
      .agreementAcceptancePresent;

  const agreementSigned =
    Boolean(
      evidence.requirements
        .agreementSignedAt
    );

  const propertyRulesAccepted =
    Boolean(
      evidence.requirements
        .rulesAcceptedAt
    );

  const cancellationSnapshotPresent =
    evidence.requirements
      .cancellationSnapshotPresent;

  const legalRequirementsSatisfied =
    agreementSnapshotPresent &&
    agreementAcceptancePresent &&
    agreementSigned &&
    propertyRulesAccepted &&
    cancellationSnapshotPresent;

  const requiresIdentityVerification =
    evidence.requirements
      .requiresIdentityVerification;

  const identityCompleted =
    evidence.verification.status ===
      "COMPLETED" &&
    Boolean(
      evidence.verification
        .verifiedAt
    );

  const identityNotRequired =
    requiresIdentityVerification ===
      false &&
    evidence.verification.status ===
      "NOT_REQUIRED" &&
    agreementSigned;

  const identityRequirementSatisfied =
    requiresIdentityVerification ===
      true
      ? identityCompleted
      : requiresIdentityVerification ===
          false
        ? identityNotRequired
        : false;

  const verificationSatisfied =
    legalRequirementsSatisfied &&
    identityRequirementSatisfied;

  const canonicalGrant =
    evidence.access
      .canonicalGuestGrant;

  const canonicalGrantActive =
    canonicalGrant?.status ===
    AccessStatus.ACTIVE;

  const canonicalGrantUsesPasscode =
    canonicalGrant?.method ===
    AccessMethod.PASSCODE_TIMEBOUND;

  const canonicalGrantHasSecureEvidence =
    Boolean(
      canonicalGrant
        ?.ttlockKeyboardPwdIdPresent
    ) &&
    Boolean(
      canonicalGrant
        ?.secureAccessCodePresent
    );

  const accessEligibilitySatisfied =
    evidence.access.releaseStatus ===
      GuestAccessReleaseStatus
        .ELIGIBLE ||
    evidence.access.releaseStatus ===
      GuestAccessReleaseStatus
        .RELEASED;

  const accessProvisioningSatisfied =
    evidence.access.releaseStatus ===
      GuestAccessReleaseStatus
        .RELEASED &&
    Boolean(
      evidence.access.releasedAt
    ) &&
    Boolean(canonicalGrant) &&
    canonicalGrantActive &&
    canonicalGrantUsesPasscode &&
    canonicalGrantHasSecureEvidence;

  const unresolvedGuestNfcCount =
    evidence.access
      .guestNfcScheduled +
    evidence.access
      .guestNfcProvisioning +
    evidence.access
      .guestNfcActive +
    evidence.access
      .guestNfcFailed;

  const accessClosureSatisfied =
    evidence.access
      .guestGrantsRevoked > 0 &&
    evidence.access
      .guestGrantsOpen === 0 &&
    unresolvedGuestNfcCount === 0;

  if (reservationActive) {
    satisfiedRequirements.push(
      "RESERVATION_ACTIVE"
    );
  } else {
    missingRequirements.push(
      "RESERVATION_ACTIVE"
    );
  }

  if (stayNotEnded) {
    satisfiedRequirements.push(
      "STAY_NOT_ENDED"
    );
  } else {
    missingRequirements.push(
      "STAY_NOT_ENDED"
    );
  }

  if (paymentSatisfied) {
    satisfiedRequirements.push(
      "PAYMENT_PAID"
    );
  } else {
    missingRequirements.push(
      "PAYMENT_PAID"
    );

    if (
      reservationActive &&
      temporalPhase !==
        "POST_CHECKOUT"
    ) {
      addBlocker({
        code:
          "PAYMENT_NOT_PAID",
        reason:
          "The reservation does not contain completed payment evidence.",
        recoverableByPinGo: true,
        coordinationIntentType:
          "REQUEST_PAYMENT_EVALUATION",
      });

      addIntent({
        intentType:
          "REQUEST_PAYMENT_EVALUATION",
        targetEngine:
          "Financial",
        reasonCode:
          "PAYMENT_NOT_PAID",
        expectedOutcomeCode:
          "PAYMENT_STATE_RESOLVED",
      });
    }
  }

  if (
    agreementSnapshotPresent
  ) {
    satisfiedRequirements.push(
      "AGREEMENT_SNAPSHOT_PRESENT"
    );
  } else {
    missingRequirements.push(
      "AGREEMENT_SNAPSHOT_PRESENT"
    );

    addBlocker({
      code:
        "AGREEMENT_SNAPSHOT_MISSING",
      reason:
        "The reservation does not contain its immutable guest agreement snapshot.",
      recoverableByPinGo: true,
      coordinationIntentType:
        "REQUEST_REQUIREMENTS_SNAPSHOT",
    });
  }

  if (
    cancellationSnapshotPresent
  ) {
    satisfiedRequirements.push(
      "CANCELLATION_SNAPSHOT_PRESENT"
    );
  } else {
    missingRequirements.push(
      "CANCELLATION_SNAPSHOT_PRESENT"
    );

    addBlocker({
      code:
        "CANCELLATION_SNAPSHOT_MISSING",
      reason:
        "The reservation does not contain its cancellation policy snapshot.",
      recoverableByPinGo: true,
      coordinationIntentType:
        "REQUEST_REQUIREMENTS_SNAPSHOT",
    });
  }

  if (
    !agreementSnapshotPresent ||
    !cancellationSnapshotPresent
  ) {
    addIntent({
      intentType:
        "REQUEST_REQUIREMENTS_SNAPSHOT",
      targetEngine:
        "Compliance",
      reasonCode:
        "REQUIREMENTS_SNAPSHOT_INCOMPLETE",
      expectedOutcomeCode:
        "REQUIREMENTS_SNAPSHOTS_PRESENT",
    });
  }

  if (
    agreementAcceptancePresent &&
    agreementSigned
  ) {
    satisfiedRequirements.push(
      "AGREEMENT_ACCEPTED"
    );
  } else {
    missingRequirements.push(
      "AGREEMENT_ACCEPTED"
    );

    if (
      agreementSnapshotPresent
    ) {
      addBlocker({
        code:
          "AGREEMENT_NOT_ACCEPTED",
        reason:
          "The applicable guest agreement has not been fully accepted and signed.",
        recoverableByPinGo: true,
        coordinationIntentType:
          "REQUEST_GUEST_VERIFICATION",
      });
    }
  }

  if (propertyRulesAccepted) {
    satisfiedRequirements.push(
      "PROPERTY_RULES_ACCEPTED"
    );
  } else {
    missingRequirements.push(
      "PROPERTY_RULES_ACCEPTED"
    );

    if (
      agreementSnapshotPresent
    ) {
      addBlocker({
        code:
          "PROPERTY_RULES_NOT_ACCEPTED",
        reason:
          "The guest has not completed the persisted property-rules acceptance.",
        recoverableByPinGo: true,
        coordinationIntentType:
          "REQUEST_GUEST_VERIFICATION",
      });
    }
  }

  if (
    identityRequirementSatisfied
  ) {
    satisfiedRequirements.push(
      "IDENTITY_REQUIREMENT_SATISFIED"
    );
  } else {
    missingRequirements.push(
      "IDENTITY_REQUIREMENT_SATISFIED"
    );

    if (
      requiresIdentityVerification ===
      true
    ) {
      addBlocker({
        code:
          evidence.verification
            .status ===
          "REQUIRES_INPUT"
            ? "IDENTITY_REQUIRES_INPUT"
            : "IDENTITY_PENDING",
        reason:
          evidence.verification
            .status ===
          "REQUIRES_INPUT"
            ? "Identity verification requires additional guest input."
            : "Required identity verification has not produced completed evidence.",
        recoverableByPinGo: true,
        coordinationIntentType:
          "REQUEST_GUEST_VERIFICATION",
      });
    }
  }

  if (
    reservationActive &&
    stayNotEnded &&
    paymentSatisfied &&
    guestTokenValid &&
    agreementSnapshotPresent &&
    cancellationSnapshotPresent &&
    !verificationSatisfied
  ) {
    addIntent({
      intentType:
        "REQUEST_GUEST_VERIFICATION",
      targetEngine:
        "Compliance",
      reasonCode:
        "GUEST_REQUIREMENTS_INCOMPLETE",
      expectedOutcomeCode:
        "GUEST_VERIFICATION_REQUIREMENTS_SATISFIED",
    });
  }

  if (
    !verificationSatisfied &&
    reservationActive &&
    stayNotEnded
  ) {
    if (
      evidence.reservation
        .guestTokenPresent
    ) {
      if (guestTokenValid) {
        satisfiedRequirements.push(
          "GUEST_TOKEN_VALID"
        );
      } else {
        missingRequirements.push(
          "GUEST_TOKEN_VALID"
        );

        addBlocker({
          code:
            "GUEST_TOKEN_EXPIRED",
          reason:
            "The persisted guest verification token is expired or has no valid expiration.",
          recoverableByPinGo:
            false,
          coordinationIntentType:
            null,
        });
      }
    } else {
      missingRequirements.push(
        "GUEST_TOKEN_VALID"
      );

      addBlocker({
        code:
          "GUEST_TOKEN_MISSING",
        reason:
          "The reservation does not contain a guest verification token.",
        recoverableByPinGo:
          false,
        coordinationIntentType:
          null,
      });
    }
  }

  if (
    verificationSatisfied
  ) {
    satisfiedRequirements.push(
      "GUEST_VERIFICATION_COMPLETED"
    );
  } else {
    missingRequirements.push(
      "GUEST_VERIFICATION_COMPLETED"
    );
  }

  if (
    accessEligibilitySatisfied
  ) {
    satisfiedRequirements.push(
      "ACCESS_ELIGIBILITY_CONFIRMED"
    );
  } else if (
    verificationSatisfied &&
    reservationActive &&
    temporalPhase !==
      "POST_CHECKOUT"
  ) {
    missingRequirements.push(
      "ACCESS_ELIGIBILITY_CONFIRMED"
    );

    addBlocker({
      code:
        "ACCESS_NOT_ELIGIBLE",
      reason:
        "Guest verification is complete, but Access eligibility is not yet persistently confirmed.",
      recoverableByPinGo: true,
      coordinationIntentType:
        "REQUEST_ACCESS_EVALUATION",
    });

    addIntent({
      intentType:
        "REQUEST_ACCESS_EVALUATION",
      targetEngine:
        "Access",
      reasonCode:
        "ACCESS_ELIGIBILITY_NOT_CONFIRMED",
      expectedOutcomeCode:
        "ACCESS_RELEASE_STATUS_ELIGIBLE",
    });
  }

  if (
    accessProvisioningSatisfied
  ) {
    satisfiedRequirements.push(
      "ACCESS_PROVISIONED"
    );
  } else if (
    verificationSatisfied &&
    reservationActive &&
    temporalPhase !==
      "POST_CHECKOUT"
  ) {
    missingRequirements.push(
      "ACCESS_PROVISIONED"
    );

    addBlocker({
      code:
        "ACCESS_NOT_PROVISIONED",
      reason:
        "Guest requirements are satisfied, but complete active access evidence is not present.",
      recoverableByPinGo: true,
      coordinationIntentType:
        "REQUEST_ACCESS_PROVISIONING",
    });

    if (
      accessEligibilitySatisfied
    ) {
      addIntent({
        intentType:
          "REQUEST_ACCESS_PROVISIONING",
        targetEngine:
          "Access",
        reasonCode:
          "ACCESS_PROVISIONING_INCOMPLETE",
        expectedOutcomeCode:
          "SECURE_GUEST_ACCESS_ACTIVE",
      });
    }
  }

  if (
    accessClosureSatisfied
  ) {
    satisfiedRequirements.push(
      "ACCESS_CLOSURE_CONFIRMED"
    );
  } else if (
    temporalPhase ===
      "POST_CHECKOUT"
  ) {
    missingRequirements.push(
      "ACCESS_CLOSURE_CONFIRMED"
    );

    addBlocker({
      code:
        "ACCESS_REVOCATION_PENDING",
      reason:
        "Checkout has been reached, but complete Guest Access closure is not persistently verified.",
      recoverableByPinGo: true,
      coordinationIntentType:
        "REQUEST_ACCESS_REVOCATION_CHECK",
    });

    addIntent({
      intentType:
        "REQUEST_ACCESS_REVOCATION_CHECK",
      targetEngine:
        "Access",
      reasonCode:
        "CHECKOUT_ACCESS_CLOSURE_NOT_VERIFIED",
      expectedOutcomeCode:
        "ALL_GUEST_ACCESS_CLOSED",
    });
  }

  if (
    evidence.verification
      .status ===
      "COMPLETED" &&
    !evidence.verification
      .verifiedAt
  ) {
    addInconsistency({
      code:
        "VERIFIED_STATUS_WITHOUT_VERIFIED_AT",
      reason:
        "Verification status is COMPLETED without a verifiedAt timestamp.",
      severity: "CRITICAL",
      repairableByPinGo:
        false,
    });
  }

  if (
    evidence.verification
      .status ===
      "NOT_REQUIRED" &&
    (
      !agreementSnapshotPresent ||
      !agreementSigned
    )
  ) {
    addInconsistency({
      code:
        "NOT_REQUIRED_WITHOUT_AGREEMENT_EVIDENCE",
      reason:
        "Identity is marked NOT_REQUIRED without complete agreement evidence.",
      severity: "CRITICAL",
      repairableByPinGo:
        false,
    });
  }

  if (
    typeof requiresIdentityVerification ===
      "boolean" &&
    evidence.requirements
      .identityVerificationRequiredSnapshot !==
      null &&
    evidence.requirements
      .identityVerificationRequiredSnapshot !==
      requiresIdentityVerification
  ) {
    addInconsistency({
      code:
        "IDENTITY_REQUIREMENT_SNAPSHOT_CONFLICT",
      reason:
        "The agreement snapshot and reservation identity requirement snapshot disagree.",
      severity: "CRITICAL",
      repairableByPinGo:
        false,
      metadata: {
        agreementRequiresIdentity:
          requiresIdentityVerification,
        reservationRequiresIdentity:
          evidence.requirements
            .identityVerificationRequiredSnapshot,
      },
    });
  }

  if (
    evidence.access
      .releaseStatus ===
      GuestAccessReleaseStatus
        .RELEASED &&
    !accessProvisioningSatisfied
  ) {
    addInconsistency({
      code:
        "RELEASED_FLAG_WITHOUT_ACTIVE_ACCESS",
      reason:
        "The reservation claims released access without complete active access evidence.",
      severity: "CRITICAL",
      repairableByPinGo:
        true,
    });
  }

  if (
    canonicalGrantActive &&
    (
      !canonicalGrantUsesPasscode ||
      !canonicalGrantHasSecureEvidence
    )
  ) {
    addInconsistency({
      code:
        "ACTIVE_ACCESS_WITHOUT_SECURE_CODE",
      reason:
        "An active canonical Guest Access grant lacks complete secure passcode evidence.",
      severity: "CRITICAL",
      repairableByPinGo:
        true,
      metadata: {
        accessGrantId:
          canonicalGrant?.id ??
          null,
      },
    });
  }

  if (
    canonicalGrantActive &&
    !verificationSatisfied
  ) {
    addInconsistency({
      code:
        "ACCESS_PRESENT_WITHOUT_VERIFICATION_EVIDENCE",
      reason:
        "Active guest access exists without sufficient Guest Journey verification evidence.",
      severity: "CRITICAL",
      repairableByPinGo:
        true,
      metadata: {
        accessGrantId:
          canonicalGrant?.id ??
          null,
      },
    });
  }

  if (
    evidence.access
      .canonicalGuestGrantCandidateCount >
      1
  ) {
    addInconsistency({
      code:
        "MULTIPLE_CANONICAL_GUEST_GRANTS",
      reason:
        "More than one Guest Access grant qualifies as a canonical access candidate.",
      severity: "CRITICAL",
      repairableByPinGo:
        true,
      metadata: {
        candidateCount:
          evidence.access
            .canonicalGuestGrantCandidateCount,
      },
    });
  }

  const verificationReady =
    reservationActive &&
    stayNotEnded &&
    paymentSatisfied &&
    guestTokenValid &&
    agreementSnapshotPresent &&
    cancellationSnapshotPresent;

  let expectedState:
    GuestJourneyState;

  if (
    evidence.reservation.status ===
    ReservationStatus.CANCELLED
  ) {
    expectedState =
      GuestJourneyState
        .JOURNEY_CANCELLED;
  } else if (
    temporalPhase ===
    "POST_CHECKOUT"
  ) {
    expectedState =
      accessClosureSatisfied
        ? GuestJourneyState
            .JOURNEY_COMPLETED
        : GuestJourneyState
            .CHECKOUT_DUE;
  } else if (
    temporalPhase ===
    "IN_STAY" &&
    accessProvisioningSatisfied
  ) {
    expectedState =
      GuestJourneyState
        .STAY_ACTIVE;
  } else if (
    temporalPhase ===
    "ARRIVAL_WINDOW" &&
    accessProvisioningSatisfied
  ) {
    expectedState =
      GuestJourneyState
        .READY_FOR_ARRIVAL;
  } else if (
    accessProvisioningSatisfied
  ) {
    expectedState =
      GuestJourneyState
        .ACCESS_SCHEDULED;
  } else if (
    verificationSatisfied
  ) {
    expectedState =
      GuestJourneyState
        .VERIFICATION_COMPLETED;
  } else if (
    verificationReady
  ) {
    expectedState =
      GuestJourneyState
        .VERIFICATION_PENDING;
  } else {
    expectedState =
      GuestJourneyState
        .RESERVATION_CONFIRMED;
  }

  const persistedState =
    evidence.persistedJourney
      .currentState;

  const comparison =
    determineComparison({
      persistedState,
      expectedState,
    });

  if (
    comparison ===
    "AHEAD_OF_EVIDENCE"
  ) {
    addInconsistency({
      code:
        "JOURNEY_AHEAD_OF_EVIDENCE",
      reason:
        `The persisted journey state ${persistedState} is ahead of the highest state supported by evidence: ${expectedState}.`,
      severity: "CRITICAL",
      repairableByPinGo:
        true,
      metadata: {
        persistedState,
        expectedState,
      },
    });
  }

  if (
    persistedState ===
      GuestJourneyState
        .JOURNEY_COMPLETED &&
    !accessClosureSatisfied
  ) {
    addInconsistency({
      code:
        "COMPLETED_JOURNEY_WITH_OPEN_ACCESS",
      reason:
        "The journey is completed while Guest Access closure is not persistently verified.",
      severity: "CRITICAL",
      repairableByPinGo:
        true,
    });
  }

  if (
    persistedState ===
      GuestJourneyState
        .JOURNEY_CANCELLED &&
    reservationActive
  ) {
    addInconsistency({
      code:
        "CANCELLED_JOURNEY_WITH_ACTIVE_RESERVATION",
      reason:
        "The journey is cancelled while the canonical reservation remains active.",
      severity: "CRITICAL",
      repairableByPinGo:
        false,
    });
  }

  if (
    comparison ===
    "TERMINAL_CONTRADICTION"
  ) {
    addInconsistency({
      code:
        "TERMINAL_STATE_CONTRADICTION",
      reason:
        `The immutable persisted terminal state ${persistedState} contradicts the current evidence-supported state ${expectedState}.`,
      severity: "CRITICAL",
      repairableByPinGo:
        false,
      metadata: {
        persistedState,
        expectedState,
      },
    });
  }

  if (
    !evidence.persistedJourney
      .exists
  ) {
    internalRepairs.push({
      code:
        "CREATE_MISSING_JOURNEY",
      reason:
        "The reservation has no canonical Guest Journey.",
      metadata: {
        expectedState,
      },
    });
  }

  if (
    evidence.persistedJourney
      .exists &&
    persistedState
  ) {
    const requiredTimestamp =
      timestampForState(
        evidence,
        persistedState
      );

    if (
      requiredTimestamp === null
    ) {
      internalRepairs.push({
        code:
          "REPAIR_GUEST_JOURNEY_TIMESTAMP",
        reason:
          `The persisted state ${persistedState} is missing its canonical lifecycle timestamp.`,
        metadata: {
          persistedState,
        },
      });
    }
  }

  const hasObsoleteActiveIntent =
    evidence.activeIntents.some(
      (intent) =>
        ACTIVE_INTENT_STATUSES.has(
          intent.status
        ) &&
        intent.evidenceFingerprint !==
          evidenceFingerprint
    );

  if (hasObsoleteActiveIntent) {
    internalRepairs.push({
      code:
        "SUPERSEDE_OBSOLETE_INTENT",
      reason:
        "One or more active coordination intents were created from obsolete evidence.",
      metadata: {
        evidenceFingerprint,
      },
    });
  }

  if (
    evidence.reservation.status ===
    ReservationStatus.CANCELLED
  ) {
    blockersByCode.clear();
    proposedIntents.clear();
  }

  if (
    evidence.reservation.status ===
      ReservationStatus.CANCELLED &&
    (
      evidence.access
        .guestGrantsOpen > 0 ||
      unresolvedGuestNfcCount > 0
    )
  ) {
    addIntent({
      intentType:
        "REQUEST_ACCESS_REVOCATION_CHECK",
      targetEngine:
        "Access",
      reasonCode:
        "CANCELLED_RESERVATION_ACCESS_STILL_OPEN",
      expectedOutcomeCode:
        "ALL_GUEST_ACCESS_CLOSED",
    });
  }

  for (
    const communicationSignal of
    evidence.communications.signals
  ) {
    if (
      communicationSignal.status
        .trim()
        .toUpperCase() !==
      "FAILED"
    ) {
      continue;
    }

    addIntent({
      intentType:
        "REQUEST_COMMUNICATION_RETRY",
      targetEngine:
        "Communications",
      reasonCode:
        "COMMUNICATION_DELIVERY_FAILED",
      expectedOutcomeCode:
        "COMMUNICATION_DELIVERY_FINAL",
      payload: {
        communicationType:
          communicationSignal
            .communicationType,
        channel:
          communicationSignal.channel,
      },
    });
  }

  const stateReason =
    getStateReason(
      expectedState
    );

  return {
    contractVersion:
      CANONICAL_GUEST_JOURNEY_EVALUATOR_VERSION,

    reservationId:
      evidence.reservation.id,

    evaluatedAt: now,
    evidenceFingerprint,

    temporalPhase,

    expectedState,
    persistedState,

    comparison,

    stateReasonCode:
      stateReason.code,

    stateReason:
      stateReason.reason,

    terminal:
      isTerminalGuestJourneyState(
        expectedState
      ),

    satisfiedRequirements:
      uniqueSorted(
        satisfiedRequirements
      ),

    missingRequirements:
      uniqueSorted(
        missingRequirements
      ),

    blockers:
      [...blockersByCode.values()]
        .sort((first, second) =>
          first.code.localeCompare(
            second.code
          )
        ),

    inconsistencies:
      [...inconsistenciesByCode.values()]
        .sort((first, second) =>
          first.code.localeCompare(
            second.code
          )
        ),

    requiredInternalRepairs:
      internalRepairs.sort(
        (first, second) =>
          first.code.localeCompare(
            second.code
          )
      ),

    requiredCoordinationIntents:
      [...proposedIntents.values()]
        .sort((first, second) =>
          [
            first.intentType,
            first.reasonCode,
          ]
            .join(":")
            .localeCompare(
              [
                second.intentType,
                second.reasonCode,
              ].join(":")
            )
        ),

    outcomeEvidence: {
      reservationActive,
      stayNotEnded,
      paymentSatisfied,
      legalRequirementsSatisfied,
      identityRequirementSatisfied,
      accessEligibilitySatisfied,
      accessProvisioningSatisfied,
      accessClosureSatisfied,
    },
  };
}