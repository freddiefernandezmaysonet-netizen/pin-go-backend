import assert from "node:assert/strict";
import test from "node:test";

import {
  AccessMethod,
  AccessStatus,
  GuestAccessMode,
  GuestAccessReleaseStatus,
  GuestJourneyState,
  PaymentState,
  ReservationStatus,
} from "@prisma/client";

import {
  GUEST_JOURNEY_EVIDENCE_CONTRACT_VERSION,
} from "./guest-journey-contract";

import type {
  GuestJourneyEvidenceSnapshot,
} from "./guest-journey-contract";

import {
  evaluateCanonicalGuestJourney,
} from "./guest-journey-evaluator";
import {
  buildGuestJourneyCoordinationIntentKeyFromProposal,
} from "./guest-journey-coordination-intent-key";

type EvidenceOverrides = {
  evaluatedAt?: Date;

  reservation?: Partial<
    GuestJourneyEvidenceSnapshot["reservation"]
  >;

  requirements?: Partial<
    GuestJourneyEvidenceSnapshot["requirements"]
  >;

  verification?: Partial<
    GuestJourneyEvidenceSnapshot["verification"]
  >;

  access?: Partial<
    GuestJourneyEvidenceSnapshot["access"]
  >;

  communications?: Partial<
    GuestJourneyEvidenceSnapshot["communications"]
  >;

  persistedJourney?: Partial<
    GuestJourneyEvidenceSnapshot["persistedJourney"]
  >;

  activeIntents?:
    GuestJourneyEvidenceSnapshot["activeIntents"];
};

const CHECK_IN =
  new Date("2026-08-10T16:00:00.000Z");

const CHECK_OUT =
  new Date("2026-08-12T15:00:00.000Z");

const AGREEMENT_SIGNED_AT =
  new Date("2026-08-02T14:00:00.000Z");

const VERIFIED_AT =
  new Date("2026-08-02T14:05:00.000Z");

const ACCESS_RELEASED_AT =
  new Date("2026-08-10T14:00:00.000Z");

function createEvidence(
  overrides: EvidenceOverrides = {}
): GuestJourneyEvidenceSnapshot {
  return {
    contractVersion:
      GUEST_JOURNEY_EVIDENCE_CONTRACT_VERSION,

    evaluatedAt:
      overrides.evaluatedAt ??
      new Date(
        "2026-08-01T12:00:00.000Z"
      ),

    reservation: {
      id: "reservation-1",
      reservationNumber:
        "PG-2026-000001",
      propertyId: "property-1",
      organizationId:
        "organization-1",

      status:
        ReservationStatus.ACTIVE,

      paymentState:
        PaymentState.PAID,

      source: "DIRECT_BOOKING",
      preferredLanguage: "en",

      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      cancelledAt: null,

      guestTokenPresent: true,
      guestTokenExpiresAt:
        new Date(
          "2026-08-13T15:00:00.000Z"
        ),

      ...overrides.reservation,
    },

    requirements: {
      agreementSnapshotPresent: true,
      agreementAcceptancePresent: false,
      agreementSignedAt: null,
      rulesAcceptedAt: null,

      cancellationSnapshotPresent:
        true,

      requiresIdentityVerification:
        true,

      identityVerificationRequiredSnapshot:
        true,

      agreementLanguage: "en",
      agreementVersion: "v1",

      ...overrides.requirements,
    },

    verification: {
      status: "PENDING",
      verifiedAt: null,
      attempts: 0,
      lastError: null,
      providerSessionPresent: false,

      ...overrides.verification,
    },

    access: {
      mode:
        GuestAccessMode.PASSCODE_ONLY,

      releaseStatus:
        GuestAccessReleaseStatus.BLOCKED,

      eligibleAt: null,
      releasedAt: null,

      canonicalGuestGrant: null,

      canonicalGuestGrantCandidateCount:
        0,

      guestGrantsOpen: 0,
      guestGrantsRevoked: 0,

      guestNfcScheduled: 0,
      guestNfcProvisioning: 0,
      guestNfcActive: 0,
      guestNfcFailed: 0,

      ...overrides.access,
    },

    communications: {
      signals: [],

      ...overrides.communications,
    },

    persistedJourney: {
      exists: true,
      id: "journey-1",

      currentState:
        GuestJourneyState
          .RESERVATION_CONFIRMED,

      stateChangedAt:
        new Date(
          "2026-08-01T11:00:00.000Z"
        ),

      verificationCompletedAt: null,
      accessScheduledAt: null,
      readyForArrivalAt: null,
      stayActiveAt: null,
      checkoutDueAt: null,
      completedAt: null,
      cancelledAt: null,

      ...overrides.persistedJourney,
    },

    activeIntents:
      overrides.activeIntents ?? [],
  };
}

function completedVerificationOverrides(): Pick<
  EvidenceOverrides,
  "requirements" | "verification"
> {
  return {
    requirements: {
      agreementSnapshotPresent: true,
      agreementAcceptancePresent: true,
      agreementSignedAt:
        AGREEMENT_SIGNED_AT,
      rulesAcceptedAt:
        AGREEMENT_SIGNED_AT,
      cancellationSnapshotPresent:
        true,
      requiresIdentityVerification:
        true,
      identityVerificationRequiredSnapshot:
        true,
    },

    verification: {
      status: "COMPLETED",
      verifiedAt: VERIFIED_AT,
      attempts: 1,
      lastError: null,
      providerSessionPresent: true,
    },
  };
}

function completedAccessOverrides(): Pick<
  EvidenceOverrides,
  "requirements" | "verification" | "access"
> {
  return {
    ...completedVerificationOverrides(),

    access: {
      releaseStatus:
        GuestAccessReleaseStatus.RELEASED,

      eligibleAt:
        new Date(
          "2026-08-02T14:06:00.000Z"
        ),

      releasedAt:
        ACCESS_RELEASED_AT,

      canonicalGuestGrant: {
        id: "grant-1",
        status: AccessStatus.ACTIVE,
        method:
          AccessMethod.PASSCODE_TIMEBOUND,

        startsAt:
          CHECK_IN,

        endsAt: CHECK_OUT,

        ttlockKeyboardPwdIdPresent:
          true,

        secureAccessCodePresent:
          true,
      },

      canonicalGuestGrantCandidateCount:
        1,

      guestGrantsOpen: 1,
      guestGrantsRevoked: 0,
    },
  };
}

function intentTypes(
  evaluation:
    ReturnType<
      typeof evaluateCanonicalGuestJourney
    >
) {
  return evaluation
    .requiredCoordinationIntents
    .map((intent) => intent.intentType);
}

function blockerCodes(
  evaluation:
    ReturnType<
      typeof evaluateCanonicalGuestJourney
    >
) {
  return evaluation.blockers.map(
    (blocker) => blocker.code
  );
}

function inconsistencyCodes(
  evaluation:
    ReturnType<
      typeof evaluateCanonicalGuestJourney
    >
) {
  return evaluation.inconsistencies.map(
    (inconsistency) =>
      inconsistency.code
  );
}

test(
  "keeps an incomplete active reservation at RESERVATION_CONFIRMED",
  () => {
    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          reservation: {
            paymentState:
              PaymentState.NONE,
            guestTokenPresent: false,
            guestTokenExpiresAt: null,
          },

          requirements: {
            agreementSnapshotPresent:
              false,

            cancellationSnapshotPresent:
              false,

            requiresIdentityVerification:
              "UNKNOWN",

            identityVerificationRequiredSnapshot:
              null,
          },
        })
      );

    assert.equal(
      evaluation.expectedState,
      GuestJourneyState
        .RESERVATION_CONFIRMED
    );

    assert.equal(
      evaluation.temporalPhase,
      "PRE_ARRIVAL"
    );

    assert.ok(
      blockerCodes(evaluation).includes(
        "PAYMENT_NOT_PAID"
      )
    );

    assert.ok(
      blockerCodes(evaluation).includes(
        "AGREEMENT_SNAPSHOT_MISSING"
      )
    );

    assert.ok(
      intentTypes(evaluation).includes(
        "REQUEST_REQUIREMENTS_SNAPSHOT"
      )
    );

    assert.ok(
      intentTypes(evaluation).includes(
        "REQUEST_PAYMENT_EVALUATION"
      )
    );
  }
);

test(
  "does not request guest verification before payment is satisfied",
  () => {
    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          reservation: {
            paymentState:
              PaymentState.NONE,
          },
        })
      );

    assert.equal(
      evaluation.expectedState,
      GuestJourneyState
        .RESERVATION_CONFIRMED
    );

    assert.ok(
      intentTypes(evaluation).includes(
        "REQUEST_PAYMENT_EVALUATION"
      )
    );

    assert.equal(
      intentTypes(evaluation).includes(
        "REQUEST_GUEST_VERIFICATION"
      ),
      false
    );
  }
);

test(
  "moves an eligible reservation with incomplete guest requirements to VERIFICATION_PENDING",
  () => {
    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence()
      );

    assert.equal(
      evaluation.expectedState,
      GuestJourneyState
        .VERIFICATION_PENDING
    );

    assert.equal(
      evaluation.comparison,
      "BEHIND"
    );

    assert.ok(
      intentTypes(evaluation).includes(
        "REQUEST_GUEST_VERIFICATION"
      )
    );
  }
);

test(
  "treats identity as satisfied when it is not required and agreements are complete",
  () => {
    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          requirements: {
            agreementAcceptancePresent:
              true,

            agreementSignedAt:
              AGREEMENT_SIGNED_AT,

            rulesAcceptedAt:
              AGREEMENT_SIGNED_AT,

            requiresIdentityVerification:
              false,

            identityVerificationRequiredSnapshot:
              false,
          },

          verification: {
            status: "NOT_REQUIRED",
            verifiedAt: null,
          },
        })
      );

    assert.equal(
      evaluation.expectedState,
      GuestJourneyState
        .VERIFICATION_COMPLETED
    );

    assert.equal(
      evaluation.outcomeEvidence
        .identityRequirementSatisfied,
      true
    );

    assert.equal(
      evaluation.outcomeEvidence
        .legalRequirementsSatisfied,
      true
    );
  }
);

test(
  "recognizes completed required identity verification",
  () => {
    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...completedVerificationOverrides(),
        })
      );

    assert.equal(
      evaluation.expectedState,
      GuestJourneyState
        .VERIFICATION_COMPLETED
    );

    assert.equal(
      evaluation.outcomeEvidence
        .identityRequirementSatisfied,
      true
    );
  }
);

test(
  "does not accept a RELEASED flag without complete secure Access evidence",
  () => {
    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...completedVerificationOverrides(),

          access: {
            releaseStatus:
              GuestAccessReleaseStatus
                .RELEASED,

            releasedAt:
              ACCESS_RELEASED_AT,

            canonicalGuestGrant: null,
          },
        })
      );

    assert.equal(
      evaluation.expectedState,
      GuestJourneyState
        .VERIFICATION_COMPLETED
    );

    assert.equal(
      evaluation.outcomeEvidence
        .accessProvisioningSatisfied,
      false
    );

    assert.ok(
      inconsistencyCodes(
        evaluation
      ).includes(
        "RELEASED_FLAG_WITHOUT_ACTIVE_ACCESS"
      )
    );
  }
);

test(
  "recognizes complete Access evidence as ACCESS_SCHEDULED before the arrival window",
  () => {
    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...completedAccessOverrides(),
        })
      );

    assert.equal(
      evaluation.expectedState,
      GuestJourneyState
        .ACCESS_SCHEDULED
    );

    assert.equal(
      evaluation.outcomeEvidence
        .accessProvisioningSatisfied,
      true
    );
  }
);

test(
  "recognizes READY_FOR_ARRIVAL when the arrival window opens with valid Access",
  () => {
    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...completedAccessOverrides(),

          evaluatedAt:
            new Date(
              "2026-08-10T15:00:00.000Z"
            ),
        })
      );

    assert.equal(
      evaluation.temporalPhase,
      "ARRIVAL_WINDOW"
    );

    assert.equal(
      evaluation.expectedState,
      GuestJourneyState
        .READY_FOR_ARRIVAL
    );
  }
);

test(
  "recognizes STAY_ACTIVE only after check-in with valid Access",
  () => {
    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...completedAccessOverrides(),

          evaluatedAt:
            new Date(
              "2026-08-10T17:00:00.000Z"
            ),
        })
      );

    assert.equal(
      evaluation.temporalPhase,
      "IN_STAY"
    );

    assert.equal(
      evaluation.expectedState,
      GuestJourneyState
        .STAY_ACTIVE
    );
  }
);

test(
  "marks checkout due and requests Access closure while credentials remain open",
  () => {
    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...completedAccessOverrides(),

          evaluatedAt:
            new Date(
              "2026-08-12T16:00:00.000Z"
            ),
        })
      );

    assert.equal(
      evaluation.temporalPhase,
      "POST_CHECKOUT"
    );

    assert.equal(
      evaluation.expectedState,
      GuestJourneyState
        .CHECKOUT_DUE
    );

    assert.ok(
      intentTypes(evaluation).includes(
        "REQUEST_ACCESS_REVOCATION_CHECK"
      )
    );
  }
);

test(
  "completes the journey only after persistent Access closure",
  () => {
    const verified =
      completedVerificationOverrides();

    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...verified,

          evaluatedAt:
            new Date(
              "2026-08-12T16:00:00.000Z"
            ),

          access: {
            releaseStatus:
              GuestAccessReleaseStatus
                .RELEASED,

            releasedAt:
              ACCESS_RELEASED_AT,

            canonicalGuestGrant: {
              id: "grant-1",
              status:
                AccessStatus.REVOKED,

              method:
                AccessMethod
                  .PASSCODE_TIMEBOUND,

              startsAt:
                new Date(
                  "2026-08-10T14:00:00.000Z"
                ),

              endsAt: CHECK_OUT,

              ttlockKeyboardPwdIdPresent:
                true,

              secureAccessCodePresent:
                true,
            },

            canonicalGuestGrantCandidateCount:
              1,

            guestGrantsOpen: 0,
            guestGrantsRevoked: 1,

            guestNfcScheduled: 0,
            guestNfcProvisioning: 0,
            guestNfcActive: 0,
            guestNfcFailed: 0,
          },
        })
      );

    assert.equal(
      evaluation.expectedState,
      GuestJourneyState
        .JOURNEY_COMPLETED
    );

    assert.equal(
      evaluation.terminal,
      true
    );

    assert.equal(
      evaluation.outcomeEvidence
        .accessClosureSatisfied,
      true
    );
  }
);

test(
  "treats never-released zero-grant access as closed after checkout",
  () => {
    const verified =
      completedVerificationOverrides();

    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...verified,

          evaluatedAt:
            new Date(
              "2026-08-12T16:00:00.000Z"
            ),

          access: {
            releaseStatus:
              GuestAccessReleaseStatus
                .ELIGIBLE,

            eligibleAt:
              new Date(
                "2026-08-02T14:06:00.000Z"
              ),

            releasedAt: null,
            canonicalGuestGrant: null,
            canonicalGuestGrantCandidateCount:
              0,
            guestGrantsOpen: 0,
            guestGrantsRevoked: 0,
            guestNfcScheduled: 0,
            guestNfcProvisioning: 0,
            guestNfcActive: 0,
            guestNfcFailed: 0,
          },
        })
      );

    assert.equal(
      evaluation.expectedState,
      GuestJourneyState
        .JOURNEY_COMPLETED
    );
    assert.equal(
      evaluation.outcomeEvidence
        .accessClosureSatisfied,
      true
    );
    assert.equal(
      intentTypes(evaluation).includes(
        "REQUEST_ACCESS_REVOCATION_CHECK"
      ),
      false
    );
  }
);

test(
  "keeps released zero-grant access fail-safe after checkout",
  () => {
    const verified =
      completedVerificationOverrides();

    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...verified,

          evaluatedAt:
            new Date(
              "2026-08-12T16:00:00.000Z"
            ),

          access: {
            releaseStatus:
              GuestAccessReleaseStatus
                .RELEASED,

            releasedAt:
              ACCESS_RELEASED_AT,

            canonicalGuestGrant: null,
            canonicalGuestGrantCandidateCount:
              0,
            guestGrantsOpen: 0,
            guestGrantsRevoked: 0,
            guestNfcScheduled: 0,
            guestNfcProvisioning: 0,
            guestNfcActive: 0,
            guestNfcFailed: 0,
          },
        })
      );

    assert.equal(
      evaluation.expectedState,
      GuestJourneyState
        .CHECKOUT_DUE
    );
    assert.equal(
      evaluation.outcomeEvidence
        .accessClosureSatisfied,
      false
    );
    assert.ok(
      intentTypes(evaluation).includes(
        "REQUEST_ACCESS_REVOCATION_CHECK"
      )
    );
    assert.ok(
      inconsistencyCodes(
        evaluation
      ).includes(
        "RELEASED_FLAG_WITHOUT_ACTIVE_ACCESS"
      )
    );
  }
);

test(
  "cancellation takes precedence without retaining irrelevant verification blockers",
  () => {
    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          reservation: {
            status:
              ReservationStatus.CANCELLED,

            cancelledAt:
              new Date(
                "2026-08-03T10:00:00.000Z"
              ),
          },
        })
      );

    assert.equal(
      evaluation.expectedState,
      GuestJourneyState
        .JOURNEY_CANCELLED
    );

    assert.equal(
      evaluation.terminal,
      true
    );

    assert.deepEqual(
      evaluation.blockers,
      []
    );

    assert.deepEqual(
      evaluation
        .requiredCoordinationIntents,
      []
    );
  }
);

test(
  "reports a missing journey and proposes an internal reconstruction",
  () => {
    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          persistedJourney: {
            exists: false,
            id: null,
            currentState: null,
            stateChangedAt: null,
          },
        })
      );

    assert.equal(
      evaluation.comparison,
      "MISSING"
    );

    assert.ok(
      evaluation.requiredInternalRepairs
        .some(
          (repair) =>
            repair.code ===
            "CREATE_MISSING_JOURNEY"
        )
    );
  }
);

test(
  "detects a persisted journey that is ahead of its evidence",
  () => {
    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          persistedJourney: {
            currentState:
              GuestJourneyState
                .READY_FOR_ARRIVAL,

            readyForArrivalAt:
              new Date(
                "2026-08-01T11:30:00.000Z"
              ),
          },
        })
      );

    assert.equal(
      evaluation.expectedState,
      GuestJourneyState
        .VERIFICATION_PENDING
    );

    assert.equal(
      evaluation.comparison,
      "AHEAD_OF_EVIDENCE"
    );

    assert.ok(
      inconsistencyCodes(
        evaluation
      ).includes(
        "JOURNEY_AHEAD_OF_EVIDENCE"
      )
    );
  }
);

test(
  "preserves an immutable terminal and reports terminal contradiction",
  () => {
    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          persistedJourney: {
            currentState:
              GuestJourneyState
                .JOURNEY_COMPLETED,

            completedAt:
              new Date(
                "2026-08-01T11:30:00.000Z"
              ),
          },
        })
      );

    assert.equal(
      evaluation.comparison,
      "TERMINAL_CONTRADICTION"
    );

    assert.ok(
      inconsistencyCodes(
        evaluation
      ).includes(
        "TERMINAL_STATE_CONTRADICTION"
      )
    );
  }
);

test(
  "does not propose a duplicate active intent for the same evidence fingerprint",
  () => {
    const initial =
      evaluateCanonicalGuestJourney(
        createEvidence()
      );
    const proposed =
      initial.requiredCoordinationIntents
        .find(
          (intent) =>
            intent.intentType ===
            "REQUEST_GUEST_VERIFICATION"
        );

    assert.ok(proposed);
    const intentKey =
      buildGuestJourneyCoordinationIntentKeyFromProposal(
        "reservation-1",
        initial.evidenceFingerprint,
        proposed
      );

    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          activeIntents: [
            {
              id: "intent-1",
              intentKey,

              intentType:
                "REQUEST_GUEST_VERIFICATION",

              targetEngine:
                "COMPLIANCE",

              status: "PENDING",

              reasonCode:
                "GUEST_REQUIREMENTS_INCOMPLETE",

              expectedOutcomeCode:
                "GUEST_VERIFICATION_REQUIREMENTS_SATISFIED",

              evidenceFingerprint:
                initial.evidenceFingerprint,

              outcomeEvidenceFingerprint:
                null,

              claimCount: 0,
              leaseExpiresAt: null,
              nextActionAt: null,

              succeededAt: null,
              exhaustedAt: null,
              supersededAt: null,

              lastError: null,
            },
          ],
        })
      );

    assert.equal(
      intentTypes(evaluation).includes(
        "REQUEST_GUEST_VERIFICATION"
      ),
      false
    );
  }
);

test(
  "requests Communications retry without changing the canonical journey state",
  () => {
    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          communications: {
            signals: [
              {
                messageLogId:
                  "message-precheckin-email",
                communicationType:
                  "PRECHECKIN_INVITATION",

                channel: "email",
                status: "FAILED",
                retryCount: 1,

                lastError:
                  "provider unavailable",
              },
            ],
          },
        })
      );

    assert.equal(
      evaluation.expectedState,
      GuestJourneyState
        .VERIFICATION_PENDING
    );

    assert.ok(
      intentTypes(evaluation).includes(
        "REQUEST_COMMUNICATION_RETRY"
      )
    );
  }
);

test(
  "produces a stable fingerprint regardless of communication signal ordering",
  () => {
    const firstSignal = {
      messageLogId:
        "message-precheckin-email",
      communicationType:
        "PRECHECKIN_INVITATION",

      channel: "email",
      status: "SENT",
      retryCount: 0,
      lastError: null,
    };

    const secondSignal = {
      messageLogId:
        "message-verification-sms",
      communicationType:
        "VERIFICATION_REMINDER",

      channel: "sms",
      status: "FAILED",
      retryCount: 1,
      lastError: "temporary failure",
    };

    const first =
      evaluateCanonicalGuestJourney(
        createEvidence({
          communications: {
            signals: [
              firstSignal,
              secondSignal,
            ],
          },
        })
      );

    const second =
      evaluateCanonicalGuestJourney(
        createEvidence({
          communications: {
            signals: [
              secondSignal,
              firstSignal,
            ],
          },
        })
      );

    assert.equal(
      first.evidenceFingerprint,
      second.evidenceFingerprint
    );
  }
);

test(
  "changes the evidence fingerprint when the temporal phase changes the expected state",
  () => {
    const preArrival =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...completedAccessOverrides(),

          evaluatedAt:
            new Date(
              "2026-08-09T12:00:00.000Z"
            ),
        })
      );

    const arrivalWindow =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...completedAccessOverrides(),

          evaluatedAt:
            new Date(
              "2026-08-10T15:00:00.000Z"
            ),
        })
      );

    assert.equal(
      preArrival.expectedState,
      GuestJourneyState
        .ACCESS_SCHEDULED
    );

    assert.equal(
      arrivalWindow.expectedState,
      GuestJourneyState
        .READY_FOR_ARRIVAL
    );

    assert.notEqual(
      preArrival.evidenceFingerprint,
      arrivalWindow.evidenceFingerprint
    );
  }
);

test(
  "uses absolute instants across a DST boundary without shifting the two-hour arrival gate",
  () => {
    const checkIn = new Date(
      "2026-11-01T01:30:00-04:00"
    );
    const checkOut = new Date(
      "2026-11-03T11:00:00-05:00"
    );
    const access =
      completedAccessOverrides();
    const canonicalGrant =
      access.access!
        .canonicalGuestGrant!;
    const dstAccess = {
      ...access,
      access: {
        ...access.access,
        canonicalGuestGrant: {
          ...canonicalGrant,
          startsAt: new Date(
            checkIn.getTime()
          ),
          endsAt: checkOut,
        },
      },
    };

    const beforeWindow =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...dstAccess,
          evaluatedAt: new Date(
            checkIn.getTime() -
              2 * 60 * 60 * 1000 -
              1
          ),
          reservation: {
            checkIn,
            checkOut,
          },
        })
      );

    const atWindow =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...dstAccess,
          evaluatedAt: new Date(
            checkIn.getTime() -
              2 * 60 * 60 * 1000
          ),
          reservation: {
            checkIn,
            checkOut,
          },
        })
      );

    assert.equal(
      beforeWindow.expectedState,
      GuestJourneyState.ACCESS_SCHEDULED
    );
    assert.equal(
      atWindow.expectedState,
      GuestJourneyState.READY_FOR_ARRIVAL
    );
  }
);

test(
  "recognizes a fully evidenced late booking already inside the stay",
  () => {
    const access =
      completedAccessOverrides();
    const checkIn = new Date(
      "2026-08-10T16:00:00.000Z"
    );

    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...access,
          evaluatedAt: new Date(
            "2026-08-10T16:05:00.000Z"
          ),
          reservation: {
            checkIn,
          },
        })
      );

    assert.equal(
      evaluation.temporalPhase,
      "IN_STAY"
    );
    assert.equal(
      evaluation.expectedState,
      GuestJourneyState.STAY_ACTIVE
    );
  }
);

test(
  "changes its fingerprint and expected phase after a reservation date modification",
  () => {
    const access =
      completedAccessOverrides();
    const evaluatedAt = new Date(
      "2026-08-10T15:00:00.000Z"
    );

    const original =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...access,
          evaluatedAt,
        })
      );
    const modified =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...access,
          evaluatedAt,
          reservation: {
            checkIn: new Date(
              "2026-08-11T16:00:00.000Z"
            ),
            checkOut: new Date(
              "2026-08-13T15:00:00.000Z"
            ),
          },
        })
      );

    assert.equal(
      original.expectedState,
      GuestJourneyState.READY_FOR_ARRIVAL
    );
    assert.equal(
      modified.expectedState,
      GuestJourneyState
        .VERIFICATION_COMPLETED
    );
    assert.ok(
      inconsistencyCodes(
        modified
      ).includes(
        "ACCESS_WINDOW_MISMATCH"
      )
    );
    assert.ok(
      intentTypes(modified).includes(
        "REQUEST_ACCESS_PROVISIONING"
      )
    );
    assert.notEqual(
      original.evidenceFingerprint,
      modified.evidenceFingerprint
    );
  }
);

test(
  "rejects an active passcode that starts after reservation check-in",
  () => {
    const completedAccess =
      completedAccessOverrides();
    const canonicalGrant =
      completedAccess.access!
        .canonicalGuestGrant!;

    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...completedAccess,
          evaluatedAt: new Date(
            "2026-08-10T14:30:00.000Z"
          ),
          access: {
            ...completedAccess.access,
            canonicalGuestGrant: {
              ...canonicalGrant,
              startsAt: new Date(
                "2026-08-10T16:30:00.000Z"
              ),
            },
          },
        })
      );

    assert.equal(
      evaluation.expectedState,
      GuestJourneyState
        .VERIFICATION_COMPLETED
    );
    assert.ok(
      blockerCodes(
        evaluation
      ).includes(
        "ACCESS_NOT_PROVISIONED"
      )
    );
    assert.ok(
      inconsistencyCodes(
        evaluation
      ).includes(
        "ACCESS_WINDOW_MISMATCH"
      )
    );
    assert.ok(
      intentTypes(evaluation).includes(
        "REQUEST_ACCESS_PROVISIONING"
      )
    );
  }
);

test(
  "rejects an active passcode that outlives a shortened reservation",
  () => {
    const completedAccess =
      completedAccessOverrides();

    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...completedAccess,
          evaluatedAt: new Date(
            "2026-08-10T14:30:00.000Z"
          ),
          reservation: {
            checkOut: new Date(
              "2026-08-11T15:00:00.000Z"
            ),
          },
        })
      );

    assert.equal(
      evaluation.expectedState,
      GuestJourneyState
        .VERIFICATION_COMPLETED
    );
    assert.ok(
      inconsistencyCodes(
        evaluation
      ).includes(
        "ACCESS_WINDOW_MISMATCH"
      )
    );
    assert.ok(
      intentTypes(evaluation).includes(
        "REQUEST_ACCESS_PROVISIONING"
      )
    );
  }
);

test(
  "keeps NFC complementary for arrival while requiring its closure after checkout",
  () => {
    const access =
      completedAccessOverrides();

    const ready =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...access,
          evaluatedAt: new Date(
            "2026-08-10T14:00:00.000Z"
          ),
          access: {
            ...access.access,
            mode:
              GuestAccessMode.PASSCODE_PLUS_NFC,
            guestNfcScheduled: 2,
          },
        })
      );

    const checkoutBlocked =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...access,
          evaluatedAt: CHECK_OUT,
          access: {
            ...access.access,
            mode:
              GuestAccessMode.PASSCODE_PLUS_NFC,
            canonicalGuestGrant: null,
            canonicalGuestGrantCandidateCount: 0,
            guestGrantsOpen: 0,
            guestGrantsRevoked: 1,
            guestNfcActive: 1,
          },
        })
      );

    const completed =
      evaluateCanonicalGuestJourney(
        createEvidence({
          ...access,
          evaluatedAt: CHECK_OUT,
          access: {
            ...access.access,
            mode:
              GuestAccessMode.PASSCODE_PLUS_NFC,
            canonicalGuestGrant: null,
            canonicalGuestGrantCandidateCount: 0,
            guestGrantsOpen: 0,
            guestGrantsRevoked: 1,
            guestNfcActive: 0,
          },
        })
      );

    assert.equal(
      ready.expectedState,
      GuestJourneyState.READY_FOR_ARRIVAL
    );
    assert.equal(
      checkoutBlocked.expectedState,
      GuestJourneyState.CHECKOUT_DUE
    );
    assert.equal(
      completed.expectedState,
      GuestJourneyState.JOURNEY_COMPLETED
    );
  }
);

test(
  "emits only canonical target Engine identifiers",
  () => {
    const evaluation =
      evaluateCanonicalGuestJourney(
        createEvidence({
          reservation: {
            paymentState: PaymentState.NONE,
          },
          communications: {
            signals: [
              {
                messageLogId:
                  "message-precheckin-sms",
                communicationType:
                  "PRECHECKIN",
                channel: "sms",
                status: "FAILED",
                retryCount: 0,
                lastError: null,
              },
            ],
          },
        })
      );

    const allowed = new Set([
      "COMPLIANCE",
      "COMMUNICATIONS",
      "ACCESS",
      "FINANCIAL",
    ]);

    assert.ok(
      evaluation.requiredCoordinationIntents.length > 0
    );
    assert.equal(
      evaluation.requiredCoordinationIntents.every(
        (intent) => allowed.has(intent.targetEngine)
      ),
      true
    );
  }
);

test(
  "keeps distinct failed communications as distinct coordination intents",
  () => {
    const evidence = createEvidence({
      communications: {
        signals: [
          {
            messageLogId:
              "message-precheckin-email",
            communicationType:
              "PRECHECKIN_INVITATION",
            channel: "email",
            status: "FAILED",
            retryCount: 1,
            lastError: "email unavailable",
          },
          {
            messageLogId:
              "message-precheckin-sms",
            communicationType:
              "PRECHECKIN_INVITATION",
            channel: "sms",
            status: "FAILED",
            retryCount: 1,
            lastError: "sms unavailable",
          },
        ],
      },
    });
    const evaluation =
      evaluateCanonicalGuestJourney(
        evidence
      );
    const retries =
      evaluation
        .requiredCoordinationIntents
        .filter(
          (intent) =>
            intent.intentType ===
            "REQUEST_COMMUNICATION_RETRY"
        );

    assert.equal(retries.length, 2);
    assert.deepEqual(
      retries.map(
        (intent) => intent.payload?.channel
      ).sort(),
      ["email", "sms"]
    );
  }
);

test(
  "suppresses only the exact active intent key",
  () => {
    const signals = [
      {
        messageLogId:
          "message-precheckin-email",
        communicationType:
          "PRECHECKIN_INVITATION",
        channel: "email",
        status: "FAILED",
        retryCount: 1,
        lastError: "email unavailable",
      },
      {
        messageLogId:
          "message-precheckin-sms",
        communicationType:
          "PRECHECKIN_INVITATION",
        channel: "sms",
        status: "FAILED",
        retryCount: 1,
        lastError: "sms unavailable",
      },
    ];
    const first =
      evaluateCanonicalGuestJourney(
        createEvidence({
          communications: {
            signals,
          },
        })
      );
    const emailIntent =
      first.requiredCoordinationIntents
        .find(
          (intent) =>
            intent.intentType ===
              "REQUEST_COMMUNICATION_RETRY" &&
            intent.payload?.channel ===
              "email"
        );

    assert.ok(emailIntent);

    const activeIntentKey =
      buildGuestJourneyCoordinationIntentKeyFromProposal(
        "reservation-1",
        first.evidenceFingerprint,
        emailIntent
      );
    const second =
      evaluateCanonicalGuestJourney(
        createEvidence({
          communications: {
            signals,
          },
          activeIntents: [
            {
              id: "intent-email",
              intentKey:
                activeIntentKey,
              intentType:
                emailIntent.intentType,
              targetEngine:
                emailIntent.targetEngine,
              status: "PENDING",
              reasonCode:
                emailIntent.reasonCode,
              expectedOutcomeCode:
                emailIntent
                  .expectedOutcomeCode,
              evidenceFingerprint:
                first
                  .evidenceFingerprint,
              outcomeEvidenceFingerprint:
                null,
              claimCount: 0,
              leaseExpiresAt: null,
              nextActionAt: null,
              succeededAt: null,
              exhaustedAt: null,
              supersededAt: null,
              lastError: null,
            },
          ],
        })
      );
    const remainingRetries =
      second.requiredCoordinationIntents
        .filter(
          (intent) =>
            intent.intentType ===
            "REQUEST_COMMUNICATION_RETRY"
        );

    assert.equal(
      remainingRetries.length,
      1
    );
    assert.equal(
      remainingRetries[0]
        ?.payload?.channel,
      "sms"
    );
  }
);
