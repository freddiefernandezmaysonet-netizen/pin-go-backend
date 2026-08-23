import {
  AccessMethod,
  AccessStatus,
  GuestAccessMode,
  GuestAccessReleaseStatus,
  GuestJourneyState,
  PaymentState,
  ReservationStatus,
} from "@prisma/client";

import type { CanonicalEngineId } from "../apms/engine-catalog";

/**
 * Pure contracts shared by the Canonical Journey Evaluator,
 * Evidence Loader and Journey Reconciler.
 *
 * This module must not access Prisma, send communications,
 * call external providers or execute another Engine's work.
 */

export const GUEST_JOURNEY_EVIDENCE_CONTRACT_VERSION =
  "guest_journey_evidence_v1" as const;

export const CANONICAL_GUEST_JOURNEY_EVALUATOR_VERSION =
  "canonical_guest_journey_evaluator_v1" as const;

export const GUEST_JOURNEY_COORDINATION_INTENT_VERSION =
  "guest_journey_coordination_intent_v1" as const;

export const GUEST_JOURNEY_OWNER_RUNTIME_VERSION =
  "guest_journey_owner_runtime_v1" as const;

export const GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_VERSION =
  "guest_journey_mission_control_bridge_v1" as const;

export const GUEST_JOURNEY_COMMUNICATIONS_OWNER_VERSION =
  "guest_journey_communications_owner_v1" as const;

export const GUEST_JOURNEY_COMMUNICATIONS_HANDLER_CODE =
  "COMMUNICATION_RETRY_V1" as const;

export const GUEST_JOURNEY_ACCESS_OWNER_VERSION =
  "guest_journey_access_owner_v1" as const;

export const GUEST_JOURNEY_ACCESS_PROVISIONING_HANDLER_CODE =
  "ACCESS_PROVISIONING_V1" as const;

export const GUEST_JOURNEY_ACCESS_REVOCATION_HANDLER_CODE =
  "ACCESS_REVOCATION_CHECK_V1" as const;

export const GUEST_JOURNEY_MISSION_CONTROL_OPERATIONAL_ISSUE_CODE =
  "GUEST_JOURNEY_OWNER_RUNTIME_STATUS" as const;

export const GUEST_JOURNEY_ACCESS_EVALUATION_HANDLER_CODE =
  "ACCESS_EVALUATION_V1" as const;

/**
 * Normal forward lifecycle.
 *
 * JOURNEY_CANCELLED is a terminal alternate path and is
 * intentionally excluded from this ordered progression.
 */
export const CANONICAL_GUEST_JOURNEY_STATE_ORDER = [
  GuestJourneyState.RESERVATION_CONFIRMED,
  GuestJourneyState.VERIFICATION_PENDING,
  GuestJourneyState.VERIFICATION_COMPLETED,
  GuestJourneyState.ACCESS_SCHEDULED,
  GuestJourneyState.READY_FOR_ARRIVAL,
  GuestJourneyState.STAY_ACTIVE,
  GuestJourneyState.CHECKOUT_DUE,
  GuestJourneyState.JOURNEY_COMPLETED,
] as const;

export type CanonicalOrderedGuestJourneyState =
  (typeof CANONICAL_GUEST_JOURNEY_STATE_ORDER)[number];

export const TERMINAL_GUEST_JOURNEY_STATES = [
  GuestJourneyState.JOURNEY_COMPLETED,
  GuestJourneyState.JOURNEY_CANCELLED,
] as const;

export function isTerminalGuestJourneyState(
  state: GuestJourneyState
): boolean {
  return TERMINAL_GUEST_JOURNEY_STATES.some(
    (terminalState) => terminalState === state
  );
}

export function getCanonicalGuestJourneyStateRank(
  state: GuestJourneyState
): number | null {
  const index =
    CANONICAL_GUEST_JOURNEY_STATE_ORDER.findIndex(
      (candidate) => candidate === state
    );

  return index >= 0 ? index : null;
}

export type GuestJourneyTemporalPhase =
  | "PRE_ARRIVAL"
  | "ARRIVAL_WINDOW"
  | "IN_STAY"
  | "POST_CHECKOUT";

export type GuestJourneyStateComparison =
  | "MISSING"
  | "ALIGNED"
  | "BEHIND"
  | "AHEAD_OF_EVIDENCE"
  | "TERMINAL_CONTRADICTION";

export const GUEST_JOURNEY_COORDINATION_INTENT_TYPES = [
  "REQUEST_REQUIREMENTS_SNAPSHOT",
  "REQUEST_GUEST_VERIFICATION",
  "REQUEST_COMMUNICATION",
  "REQUEST_COMMUNICATION_RETRY",
  "REQUEST_ACCESS_EVALUATION",
  "REQUEST_ACCESS_PROVISIONING",
  "REQUEST_ACCESS_REVOCATION_CHECK",
  "REQUEST_PAYMENT_EVALUATION",
] as const;

export type GuestJourneyCoordinationIntentType =
  (typeof GUEST_JOURNEY_COORDINATION_INTENT_TYPES)[number];

export const GUEST_JOURNEY_TARGET_ENGINES = [
  "COMPLIANCE",
  "COMMUNICATIONS",
  "ACCESS",
  "FINANCIAL",
] as const satisfies readonly CanonicalEngineId[];

export type GuestJourneyTargetEngine =
  (typeof GUEST_JOURNEY_TARGET_ENGINES)[number];

export const GUEST_JOURNEY_COMMUNICATION_TYPES = [
  "BOOKING_CONFIRMATION",
  "PRECHECKIN_INVITATION",
  "VERIFICATION_REMINDER",
  "ACCESS_READY",
  "CHECKOUT",
] as const;

export type GuestJourneyCommunicationType =
  (typeof GUEST_JOURNEY_COMMUNICATION_TYPES)[number];

export const GUEST_JOURNEY_COORDINATION_INTENT_STATUSES = [
  "PENDING",
  "CLAIMED",
  "WAITING_FOR_EVIDENCE",
  "RETRYABLE",
  "SUCCEEDED",
  "EXHAUSTED",
  "SUPERSEDED",
] as const;

export type GuestJourneyCoordinationIntentStatusCode =
  (typeof GUEST_JOURNEY_COORDINATION_INTENT_STATUSES)[number];

export const GUEST_JOURNEY_BLOCKER_CODES = [
  "PAYMENT_NOT_PAID",
  "GUEST_TOKEN_MISSING",
  "GUEST_TOKEN_EXPIRED",
  "AGREEMENT_SNAPSHOT_MISSING",
  "AGREEMENT_NOT_ACCEPTED",
  "PROPERTY_RULES_NOT_ACCEPTED",
  "CANCELLATION_SNAPSHOT_MISSING",
  "IDENTITY_PENDING",
  "IDENTITY_REQUIRES_INPUT",
  "ACCESS_NOT_ELIGIBLE",
  "ACCESS_NOT_PROVISIONED",
  "ACCESS_REVOCATION_PENDING",
] as const;

export type GuestJourneyBlockerCode =
  (typeof GUEST_JOURNEY_BLOCKER_CODES)[number];

export const GUEST_JOURNEY_INCONSISTENCY_CODES = [
  "VERIFIED_STATUS_WITHOUT_VERIFIED_AT",
  "NOT_REQUIRED_WITHOUT_AGREEMENT_EVIDENCE",
  "IDENTITY_REQUIREMENT_SNAPSHOT_CONFLICT",
  "RELEASED_FLAG_WITHOUT_ACTIVE_ACCESS",
  "ACTIVE_ACCESS_WITHOUT_SECURE_CODE",
  "ACCESS_WINDOW_MISMATCH",
  "ACCESS_PRESENT_WITHOUT_VERIFICATION_EVIDENCE",
  "JOURNEY_AHEAD_OF_EVIDENCE",
  "COMPLETED_JOURNEY_WITH_OPEN_ACCESS",
  "CANCELLED_JOURNEY_WITH_ACTIVE_RESERVATION",
  "TERMINAL_STATE_CONTRADICTION",
  "MULTIPLE_CANONICAL_GUEST_GRANTS",
] as const;

export type GuestJourneyInconsistencyCode =
  (typeof GUEST_JOURNEY_INCONSISTENCY_CODES)[number];

export const GUEST_JOURNEY_INTERNAL_REPAIR_CODES = [
  "CREATE_MISSING_JOURNEY",
  "REPAIR_GUEST_JOURNEY_TIMESTAMP",
  "RECOMPUTE_EXPECTED_STATE",
  "SUPERSEDE_OBSOLETE_INTENT",
  "CLOSE_RESOLVED_GUEST_JOURNEY_ISSUE",
] as const;

export type GuestJourneyInternalRepairCode =
  (typeof GUEST_JOURNEY_INTERNAL_REPAIR_CODES)[number];

export type GuestJourneyBlocker = {
  code: GuestJourneyBlockerCode;
  reason: string;
  recoverableByPinGo: boolean;
  coordinationIntentType?:
    | GuestJourneyCoordinationIntentType
    | null;
  metadata?: Record<string, unknown>;
};

export type GuestJourneyInconsistency = {
  code: GuestJourneyInconsistencyCode;
  reason: string;
  severity: "WARNING" | "CRITICAL";
  repairableByPinGo: boolean;
  metadata?: Record<string, unknown>;
};

export type GuestJourneyInternalRepair = {
  code: GuestJourneyInternalRepairCode;
  reason: string;
  metadata?: Record<string, unknown>;
};

export type ProposedJourneyCoordinationIntent = {
  intentType: GuestJourneyCoordinationIntentType;
  targetEngine: GuestJourneyTargetEngine;
  reasonCode: string;
  expectedOutcomeCode: string;
  payload?: Record<string, unknown>;
};

export type GuestJourneyCommunicationSignal = {
  messageLogId: string | null;
  communicationType: string;
  channel: string;
  status: string;
  retryCount: number;
  lastError: string | null;
};

export type GuestJourneyCoordinationIntentSnapshot = {
  id: string;
  intentKey: string;
  intentType: GuestJourneyCoordinationIntentType;
  targetEngine: GuestJourneyTargetEngine;
  status: GuestJourneyCoordinationIntentStatusCode;

  reasonCode: string;
  expectedOutcomeCode: string;
  evidenceFingerprint: string;
  outcomeEvidenceFingerprint: string | null;

  claimCount: number;
  leaseExpiresAt: Date | null;
  nextActionAt: Date | null;

  succeededAt: Date | null;
  exhaustedAt: Date | null;
  supersededAt: Date | null;

  lastError: string | null;
};

export type GuestJourneyEvidenceSnapshot = {
  contractVersion:
    typeof GUEST_JOURNEY_EVIDENCE_CONTRACT_VERSION;

  evaluatedAt: Date;

  reservation: {
    id: string;
    reservationNumber: string | null;
    propertyId: string;
    organizationId: string;

    status: ReservationStatus;
    paymentState: PaymentState;

    source: string | null;
    preferredLanguage: string;

    checkIn: Date;
    checkOut: Date;
    cancelledAt: Date | null;

    guestTokenPresent: boolean;
    guestTokenExpiresAt: Date | null;
  };

  requirements: {
    agreementSnapshotPresent: boolean;
    agreementAcceptancePresent: boolean;
    agreementSignedAt: Date | null;
    rulesAcceptedAt: Date | null;
    cancellationSnapshotPresent: boolean;

    requiresIdentityVerification:
      | true
      | false
      | "UNKNOWN";

    identityVerificationRequiredSnapshot:
      | boolean
      | null;

    agreementLanguage: string | null;
    agreementVersion: string | null;
  };

  verification: {
    status: string;
    verifiedAt: Date | null;
    attempts: number;
    lastError: string | null;
    providerSessionPresent: boolean;
  };

  access: {
    mode: GuestAccessMode;
    releaseStatus: GuestAccessReleaseStatus;
    eligibleAt: Date | null;
    releasedAt: Date | null;

    canonicalGuestGrant: {
      id: string;
      status: AccessStatus;
      method: AccessMethod;
      startsAt: Date;
      endsAt: Date;
      ttlockKeyboardPwdIdPresent: boolean;
      secureAccessCodePresent: boolean;
    } | null;

    canonicalGuestGrantCandidateCount: number;

    guestGrantsOpen: number;
    guestGrantsRevoked: number;

    guestNfcScheduled: number;
    guestNfcProvisioning: number;
    guestNfcActive: number;
    guestNfcFailed: number;
  };

  communications: {
    signals: GuestJourneyCommunicationSignal[];
  };

  persistedJourney: {
    exists: boolean;
    id: string | null;
    currentState: GuestJourneyState | null;
    stateChangedAt: Date | null;

    verificationCompletedAt: Date | null;
    accessScheduledAt: Date | null;
    readyForArrivalAt: Date | null;
    stayActiveAt: Date | null;
    checkoutDueAt: Date | null;
    completedAt: Date | null;
    cancelledAt: Date | null;
  };

  activeIntents:
    GuestJourneyCoordinationIntentSnapshot[];
};

export type CanonicalJourneyOutcomeEvidence = {
  reservationActive: boolean;
  stayNotEnded: boolean;
  paymentSatisfied: boolean;
  legalRequirementsSatisfied: boolean;
  identityRequirementSatisfied: boolean;
  accessEligibilitySatisfied: boolean;
  accessProvisioningSatisfied: boolean;
  accessClosureSatisfied: boolean;
};

export type CanonicalJourneyEvaluation = {
  contractVersion:
    typeof CANONICAL_GUEST_JOURNEY_EVALUATOR_VERSION;

  reservationId: string;
  evaluatedAt: Date;
  evidenceFingerprint: string;

  temporalPhase: GuestJourneyTemporalPhase;

  expectedState: GuestJourneyState;
  persistedState: GuestJourneyState | null;

  comparison: GuestJourneyStateComparison;

  stateReasonCode: string;
  stateReason: string;

  terminal: boolean;

  satisfiedRequirements: string[];
  missingRequirements: string[];

  blockers: GuestJourneyBlocker[];
  inconsistencies: GuestJourneyInconsistency[];

  requiredInternalRepairs:
    GuestJourneyInternalRepair[];

  requiredCoordinationIntents:
    ProposedJourneyCoordinationIntent[];

  outcomeEvidence:
    CanonicalJourneyOutcomeEvidence;
};
