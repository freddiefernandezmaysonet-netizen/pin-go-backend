import {
  AccessGrantType,
  AccessMethod,
  AccessStatus,
  GuestJourneyCoordinationIntentStatus,
  NfcAssignmentRole,
  NfcAssignmentStatus,
  Prisma,
} from "@prisma/client";

import {
  GUEST_JOURNEY_COORDINATION_INTENT_TYPES,
  GUEST_JOURNEY_EVIDENCE_CONTRACT_VERSION,
  GUEST_JOURNEY_TARGET_ENGINES,
} from "./guest-journey-contract";

import type {
  GuestJourneyCommunicationSignal,
  GuestJourneyCoordinationIntentSnapshot,
  GuestJourneyCoordinationIntentType,
  GuestJourneyEvidenceSnapshot,
  GuestJourneyTargetEngine,
} from "./guest-journey-contract";

/**
 * Guest Journey Evidence Loader V1.
 *
 * Read-only boundary between persisted operational evidence and the
 * pure Canonical Journey Evaluator.
 *
 * This service:
 * - does not mutate Reservation or GuestJourney;
 * - does not execute another Engine's work;
 * - does not send communications;
 * - does not provision/revoke credentials;
 * - never exposes passcodes, message bodies or intent payloads.
 */

const ACTIVE_INTENT_STATUSES = [
  GuestJourneyCoordinationIntentStatus.PENDING,
  GuestJourneyCoordinationIntentStatus.CLAIMED,
  GuestJourneyCoordinationIntentStatus
    .WAITING_FOR_EVIDENCE,
  GuestJourneyCoordinationIntentStatus.RETRYABLE,
] as const;

const reservationEvidenceSelect = {
  id: true,
  reservationNumber: true,
  propertyId: true,

  status: true,
  paymentState: true,

  source: true,
  preferredLanguage: true,

  checkIn: true,
  checkOut: true,
  cancelledAt: true,

  guestToken: true,
  guestTokenExpiresAt: true,

  guestAgreementSnapshot: true,
  guestAgreementAcceptance: true,
  guestAgreementSignedAt: true,
  verificationAcceptedRulesAt: true,
  cancellationPolicySnapshot: true,

  identityVerificationRequiredSnapshot: true,

  verificationStatus: true,
  verifiedAt: true,
  identityVerificationAttempts: true,
  stripeIdentityVerificationLastError: true,
  stripeIdentityVerificationSessionId: true,

  guestAccessModeSnapshot: true,
  guestAccessReleaseStatus: true,
  guestAccessEligibleAt: true,
  guestAccessReleasedAt: true,

  property: {
    select: {
      organizationId: true,
    },
  },

  guestJourney: {
    select: {
      id: true,
      currentState: true,
      stateChangedAt: true,

      verificationCompletedAt: true,
      accessScheduledAt: true,
      readyForArrivalAt: true,
      stayActiveAt: true,
      checkoutDueAt: true,
      completedAt: true,
      cancelledAt: true,
    },
  },

  accessGrants: {
    where: {
      type: AccessGrantType.GUEST,
      status: {
        not: AccessStatus.REVOKED,
      },
    },

    orderBy: [
      {
        createdAt: "desc",
      },
      {
        id: "asc",
      },
    ],

    take: 51,

    select: {
      id: true,
      method: true,
      status: true,
      startsAt: true,
      endsAt: true,
      ttlockKeyboardPwdId: true,

      secureAccessCode: {
        select: {
          id: true,
          accessCodeEnc: true,
        },
      },
    },
  },

  NfcAssignment: {
    where: {
      role: NfcAssignmentRole.GUEST,
      status: {
        in: [
          NfcAssignmentStatus.SCHEDULED,
          NfcAssignmentStatus.PROVISIONING,
          NfcAssignmentStatus.ACTIVE,
          NfcAssignmentStatus.FAILED,
        ],
      },
    },

    take: 51,

    select: {
      id: true,
      status: true,
    },
  },

  messageDispatchLogs: {
    orderBy: [
      {
        createdAt: "desc",
      },
      {
        id: "desc",
      },
    ],

    take: 100,

    select: {
      id: true,
      type: true,
      channel: true,
      status: true,
      createdAt: true,
    },
  },

  guestJourneyCoordinationIntents: {
    where: {
      status: {
        in: [
          ...ACTIVE_INTENT_STATUSES,
        ],
      },
    },

    orderBy: [
      {
        createdAt: "asc",
      },
      {
        id: "asc",
      },
    ],

    take: 101,

    select: {
      id: true,
      intentKey: true,
      intentType: true,
      targetEngine: true,
      status: true,

      reasonCode: true,
      expectedOutcomeCode: true,
      evidenceFingerprint: true,
      outcomeEvidenceFingerprint: true,

      claimCount: true,
      leaseExpiresAt: true,
      nextActionAt: true,

      succeededAt: true,
      exhaustedAt: true,
      supersededAt: true,

      lastError: true,
    },
  },

  _count: {
    select: {
      accessGrants: {
        where: {
          type: AccessGrantType.GUEST,
          status: AccessStatus.REVOKED,
        },
      },
    },
  },
} satisfies Prisma.ReservationSelect;

type ReservationEvidenceRecord =
  Prisma.ReservationGetPayload<{
    select:
      typeof reservationEvidenceSelect;
  }>;

export type GuestJourneyEvidenceTransactionClient =
  Pick<
    Prisma.TransactionClient,
    "reservation"
  >;

export type GuestJourneyEvidenceScope = {
  organizationId: string;
  propertyId: string;
};

function requireReservationId(
  value: string
): string {
  const cleanValue =
    value.trim();

  if (!cleanValue) {
    throw new Error(
      "reservationId is required"
    );
  }

  return cleanValue;
}

function requireValidDate(
  value: Date,
  fieldName: string
): Date {
  if (
    !(value instanceof Date) ||
    Number.isNaN(value.getTime())
  ) {
    throw new Error(
      `${fieldName} must be a valid Date`
    );
  }

  return value;
}

function readJsonObject(
  value: unknown
): Record<string, unknown> | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }

  return value as Record<
    string,
    unknown
  >;
}

function readNonEmptyString(
  value: unknown
): string | null {
  if (
    typeof value !== "string"
  ) {
    return null;
  }

  const cleanValue =
    value.trim();

  return cleanValue
    ? cleanValue
    : null;
}

function hasNonEmptyJsonObject(
  value: unknown
): boolean {
  const object =
    readJsonObject(value);

  return Boolean(
    object &&
    Object.keys(object).length > 0
  );
}

function parseAgreementSnapshot(
  value: unknown
): {
  present: boolean;

  requiresIdentityVerification:
    | true
    | false
    | "UNKNOWN";

  language: string | null;
  version: string | null;
} {
  const snapshot =
    readJsonObject(value);

  if (!snapshot) {
    return {
      present: false,

      requiresIdentityVerification:
        "UNKNOWN",

      language: null,
      version: null,
    };
  }

  const agreementId =
    readNonEmptyString(
      snapshot.agreementId
    );

  const propertyId =
    readNonEmptyString(
      snapshot.propertyId
    );

  const version =
    readNonEmptyString(
      snapshot.version
    );

  const capturedAt =
    readNonEmptyString(
      snapshot.capturedAt
    );

  const present =
    Boolean(
      agreementId &&
      propertyId &&
      version &&
      capturedAt
    );

  const identityRequirement =
    present &&
    typeof snapshot
      .requiresIdentityVerification ===
      "boolean"
      ? snapshot
          .requiresIdentityVerification
      : "UNKNOWN";

  return {
    present,

    requiresIdentityVerification:
      identityRequirement,

    language:
      present
        ? readNonEmptyString(
            snapshot.language
          )
        : null,

    version:
      present
        ? version
        : null,
  };
}

function hasAcceptedAgreement(
  value: unknown
): boolean {
  const acceptance =
    readJsonObject(value);

  return (
    acceptance?.accepted === true
  );
}

function requireRegisteredIntentType(
  value: string
): GuestJourneyCoordinationIntentType {
  if (
    GUEST_JOURNEY_COORDINATION_INTENT_TYPES.some(
      (candidate) =>
        candidate === value
    )
  ) {
    return value as
      GuestJourneyCoordinationIntentType;
  }

  throw new Error(
    `GUEST_JOURNEY_EVIDENCE_INVALID_INTENT_TYPE:${value}`
  );
}

function requireRegisteredTargetEngine(
  value: string
): GuestJourneyTargetEngine {
  if (
    GUEST_JOURNEY_TARGET_ENGINES.some(
      (candidate) =>
        candidate === value
    )
  ) {
    return value as
      GuestJourneyTargetEngine;
  }

  throw new Error(
    `GUEST_JOURNEY_EVIDENCE_INVALID_TARGET_ENGINE:${value}`
  );
}

function mapActiveIntent(
  intent:
    ReservationEvidenceRecord[
      "guestJourneyCoordinationIntents"
    ][number]
): GuestJourneyCoordinationIntentSnapshot {
  return {
    id: intent.id,
    intentKey: intent.intentKey,

    intentType:
      requireRegisteredIntentType(
        intent.intentType
      ),

    targetEngine:
      requireRegisteredTargetEngine(
        intent.targetEngine
      ),

    status: intent.status,

    reasonCode:
      intent.reasonCode,

    expectedOutcomeCode:
      intent.expectedOutcomeCode,

    evidenceFingerprint:
      intent.evidenceFingerprint,

    outcomeEvidenceFingerprint:
      intent
        .outcomeEvidenceFingerprint,

    claimCount:
      intent.claimCount,

    leaseExpiresAt:
      intent.leaseExpiresAt,

    nextActionAt:
      intent.nextActionAt,

    succeededAt:
      intent.succeededAt,

    exhaustedAt:
      intent.exhaustedAt,

    supersededAt:
      intent.supersededAt,

    lastError:
      intent.lastError,
  };
}

function mapDispatchSignals(
  reservation:
    ReservationEvidenceRecord
): GuestJourneyCommunicationSignal[] {
  const latestByTypeAndChannel = new Map<
    string,
    GuestJourneyCommunicationSignal
  >();

  for (const log of reservation.messageDispatchLogs) {
    const communicationType =
      readNonEmptyString(log.type) ??
      "MESSAGE_DISPATCH";
    const channel =
      readNonEmptyString(log.channel) ??
      "unknown";
    const key = `${communicationType}:${channel}`;

    if (latestByTypeAndChannel.has(key)) {
      continue;
    }

    latestByTypeAndChannel.set(key, {
      communicationType:
        communicationType,

      channel:
        channel,

      status:
        readNonEmptyString(
          log.status
        ) ?? "UNKNOWN",

      retryCount: 0,
      lastError: null,
    });
  }

  return [...latestByTypeAndChannel.values()].sort(
    (first, second) =>
      `${first.communicationType}:${first.channel}`.localeCompare(
        `${second.communicationType}:${second.channel}`
      )
  );
}

function mapPersistedJourney(
  reservation:
    ReservationEvidenceRecord
):
  GuestJourneyEvidenceSnapshot[
    "persistedJourney"
  ] {
  const journey =
    reservation.guestJourney;

  if (!journey) {
    return {
      exists: false,
      id: null,
      currentState: null,
      stateChangedAt: null,

      verificationCompletedAt:
        null,

      accessScheduledAt:
        null,

      readyForArrivalAt:
        null,

      stayActiveAt: null,
      checkoutDueAt: null,
      completedAt: null,
      cancelledAt: null,
    };
  }

  return {
    exists: true,
    id: journey.id,

    currentState:
      journey.currentState,

    stateChangedAt:
      journey.stateChangedAt,

    verificationCompletedAt:
      journey
        .verificationCompletedAt,

    accessScheduledAt:
      journey.accessScheduledAt,

    readyForArrivalAt:
      journey.readyForArrivalAt,

    stayActiveAt:
      journey.stayActiveAt,

    checkoutDueAt:
      journey.checkoutDueAt,

    completedAt:
      journey.completedAt,

    cancelledAt:
      journey.cancelledAt,
  };
}

function mapAccessEvidence(
  reservation:
    ReservationEvidenceRecord,
  now: Date
):
  GuestJourneyEvidenceSnapshot[
    "access"
  ] {
  const guestGrants =
    reservation.accessGrants;

  const canonicalCandidates =
    guestGrants.filter(
      (grant) =>
        grant.method ===
          AccessMethod
            .PASSCODE_TIMEBOUND &&
        grant.status ===
          AccessStatus.ACTIVE &&
        grant.endsAt.getTime() >
          now.getTime()
    );

  const canonicalGrant =
    canonicalCandidates[0] ??
    null;

  const guestGrantsOpen =
    guestGrants.filter(
      (grant) =>
        grant.status !==
        AccessStatus.REVOKED
    ).length;

  const guestGrantsRevoked =
    reservation._count.accessGrants;

  const guestNfcScheduled =
    reservation
      .NfcAssignment
      .filter(
        (assignment) =>
          assignment.status ===
          NfcAssignmentStatus
            .SCHEDULED
      ).length;

  const guestNfcProvisioning =
    reservation
      .NfcAssignment
      .filter(
        (assignment) =>
          assignment.status ===
          NfcAssignmentStatus
            .PROVISIONING
      ).length;

  const guestNfcActive =
    reservation
      .NfcAssignment
      .filter(
        (assignment) =>
          assignment.status ===
          NfcAssignmentStatus
            .ACTIVE
      ).length;

  const guestNfcFailed =
    reservation
      .NfcAssignment
      .filter(
        (assignment) =>
          assignment.status ===
          NfcAssignmentStatus
            .FAILED
      ).length;

  return {
    mode:
      reservation
        .guestAccessModeSnapshot,

    releaseStatus:
      reservation
        .guestAccessReleaseStatus,

    eligibleAt:
      reservation
        .guestAccessEligibleAt,

    releasedAt:
      reservation
        .guestAccessReleasedAt,

    canonicalGuestGrant:
      canonicalGrant
        ? {
            id:
              canonicalGrant.id,

            status:
              canonicalGrant.status,

            method:
              canonicalGrant.method,

            startsAt:
              canonicalGrant.startsAt,

            endsAt:
              canonicalGrant.endsAt,

            ttlockKeyboardPwdIdPresent:
              canonicalGrant
                .ttlockKeyboardPwdId !==
              null,

            secureAccessCodePresent:
              Boolean(
                canonicalGrant
                  .secureAccessCode
                  ?.accessCodeEnc
              ),
          }
        : null,

    canonicalGuestGrantCandidateCount:
      canonicalCandidates.length,

    guestGrantsOpen,
    guestGrantsRevoked,

    guestNfcScheduled,
    guestNfcProvisioning,
    guestNfcActive,
    guestNfcFailed,
  };
}

export async function loadGuestJourneyEvidence(
  tx: GuestJourneyEvidenceTransactionClient,
  reservationId: string,
  now: Date,
  expectedScope?: GuestJourneyEvidenceScope
): Promise<GuestJourneyEvidenceSnapshot> {
  const cleanReservationId =
    requireReservationId(
      reservationId
    );

  const evaluatedAt =
    requireValidDate(
      now,
      "now"
    );

  const reservation =
    await tx.reservation.findUnique({
      where: {
        id: cleanReservationId,
      },

      select:
        reservationEvidenceSelect,
    });

  if (!reservation) {
    throw new Error(
      `GUEST_JOURNEY_EVIDENCE_RESERVATION_NOT_FOUND:${cleanReservationId}`
    );
  }

  if (
    expectedScope &&
    (reservation.propertyId !== expectedScope.propertyId ||
      reservation.property.organizationId !==
        expectedScope.organizationId)
  ) {
    throw new Error(
      `GUEST_JOURNEY_EVIDENCE_SCOPE_MISMATCH:${cleanReservationId}`
    );
  }

  if (
    reservation
      .guestJourneyCoordinationIntents
      .length > 100
  ) {
    throw new Error(
      `GUEST_JOURNEY_EVIDENCE_ACTIVE_INTENT_LIMIT_EXCEEDED:${cleanReservationId}`
    );
  }

  const agreement =
    parseAgreementSnapshot(
      reservation
        .guestAgreementSnapshot
    );

  const communicationSignals =
    mapDispatchSignals(reservation);

  return {
    contractVersion:
      GUEST_JOURNEY_EVIDENCE_CONTRACT_VERSION,

    evaluatedAt,

    reservation: {
      id: reservation.id,

      reservationNumber:
        reservation
          .reservationNumber,

      propertyId:
        reservation.propertyId,

      organizationId:
        reservation.property
          .organizationId,

      status:
        reservation.status,

      paymentState:
        reservation.paymentState,

      source:
        reservation.source,

      preferredLanguage:
        reservation
          .preferredLanguage,

      checkIn:
        reservation.checkIn,

      checkOut:
        reservation.checkOut,

      cancelledAt:
        reservation.cancelledAt,

      guestTokenPresent:
        Boolean(
          readNonEmptyString(
            reservation.guestToken
          )
        ),

      guestTokenExpiresAt:
        reservation
          .guestTokenExpiresAt,
    },

    requirements: {
      agreementSnapshotPresent:
        agreement.present,

      agreementAcceptancePresent:
        hasAcceptedAgreement(
          reservation
            .guestAgreementAcceptance
        ),

      agreementSignedAt:
        reservation
          .guestAgreementSignedAt,

      rulesAcceptedAt:
        reservation
          .verificationAcceptedRulesAt,

      cancellationSnapshotPresent:
        hasNonEmptyJsonObject(
          reservation
            .cancellationPolicySnapshot
        ),

      requiresIdentityVerification:
        agreement
          .requiresIdentityVerification,

      identityVerificationRequiredSnapshot:
        reservation
          .identityVerificationRequiredSnapshot,

      agreementLanguage:
        agreement.language,

      agreementVersion:
        agreement.version,
    },

    verification: {
      status:
        reservation
          .verificationStatus,

      verifiedAt:
        reservation.verifiedAt,

      attempts:
        reservation
          .identityVerificationAttempts,

      lastError:
        readNonEmptyString(
          reservation
            .stripeIdentityVerificationLastError
        ),

      providerSessionPresent:
        Boolean(
          readNonEmptyString(
            reservation
              .stripeIdentityVerificationSessionId
          )
        ),
    },

    access:
      mapAccessEvidence(
        reservation,
        evaluatedAt
      ),

    communications: {
      signals:
        communicationSignals,
    },

    persistedJourney:
      mapPersistedJourney(
        reservation
      ),

    activeIntents:
      reservation
        .guestJourneyCoordinationIntents
        .map(mapActiveIntent),
  };
}
