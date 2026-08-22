import assert from "node:assert/strict";
import test from "node:test";

import {
  AccessMethod,
  AccessStatus,
  GuestAccessMode,
  GuestAccessReleaseStatus,
  GuestJourneyCoordinationIntentStatus,
  GuestJourneyState,
  NfcAssignmentStatus,
  PaymentState,
  ReservationStatus,
} from "@prisma/client";

import {
  GUEST_JOURNEY_EVIDENCE_CONTRACT_VERSION,
} from "./guest-journey-contract";

import {
  loadGuestJourneyEvidence,
} from "./guest-journey-evidence.service";

const NOW =
  new Date(
    "2026-08-06T18:00:00.000Z"
  );

const CHECK_IN =
  new Date(
    "2026-08-10T16:00:00.000Z"
  );

const CHECK_OUT =
  new Date(
    "2026-08-12T15:00:00.000Z"
  );

const EVIDENCE_FINGERPRINT =
  "a".repeat(64);

type MockOptions = {
  reservation?: Record<string, any> | null;
};

function createBaseReservation(): Record<string, any> {
  return {
    id: "reservation-1",

    reservationNumber:
      "PG-2026-000001",

    propertyId:
      "property-1",

    status:
      ReservationStatus.ACTIVE,

    paymentState:
      PaymentState.PAID,

    source:
      "DIRECT_BOOKING",

    preferredLanguage:
      "es",

    checkIn:
      CHECK_IN,

    checkOut:
      CHECK_OUT,

    cancelledAt:
      null,

    guestToken:
      "guest-token-secret",

    guestTokenExpiresAt:
      new Date(
        "2026-08-13T15:00:00.000Z"
      ),

    guestAgreementSnapshot: {
      agreementId:
        "agreement-1",

      propertyId:
        "property-1",

      version:
        "v1",

      language:
        "es",

      title:
        "Acuerdo",

      agreementText:
        "Terms",

      rules: [],

      guestFacingSummary:
        null,

      requiresIdentityVerification:
        true,

      requiresAgreementSignature:
        true,

      capturedAt:
        "2026-08-01T12:00:00.000Z",
    },

    guestAgreementAcceptance: {
      accepted: true,
      acceptedAt:
        "2026-08-02T14:00:00.000Z",
    },

    guestAgreementSignedAt:
      new Date(
        "2026-08-02T14:00:00.000Z"
      ),

    verificationAcceptedRulesAt:
      new Date(
        "2026-08-02T14:00:00.000Z"
      ),

    cancellationPolicySnapshot: {
      type: "FLEXIBLE",

      cancellationTermsAcceptance: {
        accepted: true,
      },
    },

    identityVerificationRequiredSnapshot:
      true,

    verificationStatus:
      "COMPLETED",

    verifiedAt:
      new Date(
        "2026-08-02T14:05:00.000Z"
      ),

    identityVerificationAttempts:
      1,

    stripeIdentityVerificationLastError:
      null,

    stripeIdentityVerificationSessionId:
      "vs_secret_session",

    guestAccessModeSnapshot:
      GuestAccessMode.PASSCODE_ONLY,

    guestAccessReleaseStatus:
      GuestAccessReleaseStatus.RELEASED,

    guestAccessEligibleAt:
      new Date(
        "2026-08-02T14:06:00.000Z"
      ),

    guestAccessReleasedAt:
      new Date(
        "2026-08-10T14:00:00.000Z"
      ),

    property: {
      organizationId:
        "organization-1",
    },

    guestJourney: {
      id:
        "journey-1",

      currentState:
        GuestJourneyState
          .VERIFICATION_COMPLETED,

      stateChangedAt:
        new Date(
          "2026-08-02T14:05:00.000Z"
        ),

      verificationCompletedAt:
        new Date(
          "2026-08-02T14:05:00.000Z"
        ),

      accessScheduledAt:
        null,

      readyForArrivalAt:
        null,

      stayActiveAt:
        null,

      checkoutDueAt:
        null,

      completedAt:
        null,

      cancelledAt:
        null,
    },

    accessGrants: [
      {
        id:
          "grant-active",

        method:
          AccessMethod
            .PASSCODE_TIMEBOUND,

        status:
          AccessStatus.ACTIVE,

        startsAt:
          new Date(
            "2026-08-10T14:00:00.000Z"
          ),

        endsAt:
          CHECK_OUT,

        ttlockKeyboardPwdId:
          123456,

        secureAccessCode: {
          id:
            "access-code-1",

          accessCodeEnc:
            "encrypted-secret",
        },
      },

      {
        id:
          "grant-revoked",

        method:
          AccessMethod
            .PASSCODE_TIMEBOUND,

        status:
          AccessStatus.REVOKED,

        startsAt:
          new Date(
            "2026-07-01T14:00:00.000Z"
          ),

        endsAt:
          new Date(
            "2026-07-03T15:00:00.000Z"
          ),

        ttlockKeyboardPwdId:
          654321,

        secureAccessCode: {
          id:
            "access-code-old",

          accessCodeEnc:
            "encrypted-old-secret",
        },
      },
    ],

    NfcAssignment: [
      {
        id:
          "nfc-scheduled",

        status:
          NfcAssignmentStatus
            .SCHEDULED,
      },

      {
        id:
          "nfc-active",

        status:
          NfcAssignmentStatus
            .ACTIVE,
      },

      {
        id:
          "nfc-ended",

        status:
          NfcAssignmentStatus
            .ENDED,
      },
    ],

    messageDispatchLogs: [
      {
        id:
          "dispatch-1",

        type:
          "BOOKING_CONFIRMATION",

        channel:
          "email",

        status:
          "SENT",

        createdAt:
          new Date(
            "2026-08-01T12:00:00.000Z"
          ),
      },
    ],

    guestJourneyCoordinationIntents: [
      {
        id:
          "intent-1",

        intentKey:
          "guest-journey-intent:1",

        intentType:
          "REQUEST_ACCESS_PROVISIONING",

        targetEngine:
          "ACCESS",

        status:
          GuestJourneyCoordinationIntentStatus
            .PENDING,

        reasonCode:
          "ACCESS_PROVISIONING_INCOMPLETE",

        expectedOutcomeCode:
          "SECURE_GUEST_ACCESS_ACTIVE",

        evidenceFingerprint:
          EVIDENCE_FINGERPRINT,

        outcomeEvidenceFingerprint:
          null,

        claimCount:
          0,

        leaseExpiresAt:
          null,

        nextActionAt:
          null,

        succeededAt:
          null,

        exhaustedAt:
          null,

        supersededAt:
          null,

        lastError:
          null,
      },
    ],

    _count: {
      accessGrants: 1,
    },
  };
}

function createMockTransaction(
  options: MockOptions = {}
) {
  const calls = {
    reservationFindUnique:
      [] as any[],
  };

  const reservation =
    options.reservation === undefined
      ? createBaseReservation()
      : options.reservation;

  const tx = {
    reservation: {
      findUnique: async (
        args: any
      ) => {
        calls
          .reservationFindUnique
          .push(args);

        return reservation;
      },
    },
  };

  return {
    tx: tx as any,
    calls,
  };
}

test(
  "loads the canonical evidence contract without exposing persisted secrets",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction();

    const evidence =
      await loadGuestJourneyEvidence(
        tx,
        " reservation-1 ",
        NOW
      );

    assert.equal(
      evidence.contractVersion,
      GUEST_JOURNEY_EVIDENCE_CONTRACT_VERSION
    );

    assert.equal(
      evidence.evaluatedAt,
      NOW
    );

    assert.deepEqual(
      evidence.reservation,
      {
        id:
          "reservation-1",

        reservationNumber:
          "PG-2026-000001",

        propertyId:
          "property-1",

        organizationId:
          "organization-1",

        status:
          ReservationStatus.ACTIVE,

        paymentState:
          PaymentState.PAID,

        source:
          "DIRECT_BOOKING",

        preferredLanguage:
          "es",

        checkIn:
          CHECK_IN,

        checkOut:
          CHECK_OUT,

        cancelledAt:
          null,

        guestTokenPresent:
          true,

        guestTokenExpiresAt:
          new Date(
            "2026-08-13T15:00:00.000Z"
          ),
      }
    );

    const serialized =
      JSON.stringify(
        evidence
      );

    assert.equal(
      serialized.includes(
        "guest-token-secret"
      ),
      false
    );

    assert.equal(
      serialized.includes(
        "vs_secret_session"
      ),
      false
    );

    assert.equal(
      serialized.includes(
        "encrypted-secret"
      ),
      false
    );

    assert.equal(
      calls
        .reservationFindUnique
        .length,
      1
    );

  }
);

test(
  "parses canonical agreement and identity requirement evidence defensively",
  async () => {
    const {
      tx,
    } = createMockTransaction();

    const evidence =
      await loadGuestJourneyEvidence(
        tx,
        "reservation-1",
        NOW
      );

    assert.deepEqual(
      evidence.requirements,
      {
        agreementSnapshotPresent:
          true,

        agreementAcceptancePresent:
          true,

        agreementSignedAt:
          new Date(
            "2026-08-02T14:00:00.000Z"
          ),

        rulesAcceptedAt:
          new Date(
            "2026-08-02T14:00:00.000Z"
          ),

        cancellationSnapshotPresent:
          true,

        requiresIdentityVerification:
          true,

        identityVerificationRequiredSnapshot:
          true,

        agreementLanguage:
          "es",

        agreementVersion:
          "v1",
      }
    );
  }
);

test(
  "reports UNKNOWN identity requirement when the agreement snapshot is malformed",
  async () => {
    const reservation =
      createBaseReservation();

    reservation.guestAgreementSnapshot = {
      agreementId:
        "agreement-1",

      propertyId:
        "property-1",

      requiresIdentityVerification:
        false,
    };

    const {
      tx,
    } = createMockTransaction({
      reservation,
    });

    const evidence =
      await loadGuestJourneyEvidence(
        tx,
        "reservation-1",
        NOW
      );

    assert.equal(
      evidence.requirements
        .agreementSnapshotPresent,
      false
    );

    assert.equal(
      evidence.requirements
        .requiresIdentityVerification,
      "UNKNOWN"
    );

    assert.equal(
      evidence.requirements
        .agreementVersion,
      null
    );
  }
);

test(
  "requires explicit accepted agreement evidence instead of object presence alone",
  async () => {
    const reservation =
      createBaseReservation();

    reservation.guestAgreementAcceptance = {
      accepted: false,
    };

    const {
      tx,
    } = createMockTransaction({
      reservation,
    });

    const evidence =
      await loadGuestJourneyEvidence(
        tx,
        "reservation-1",
        NOW
      );

    assert.equal(
      evidence.requirements
        .agreementAcceptancePresent,
      false
    );
  }
);

test(
  "maps verification outcome without exposing the provider session identifier",
  async () => {
    const {
      tx,
    } = createMockTransaction();

    const evidence =
      await loadGuestJourneyEvidence(
        tx,
        "reservation-1",
        NOW
      );

    assert.deepEqual(
      evidence.verification,
      {
        status:
          "COMPLETED",

        verifiedAt:
          new Date(
            "2026-08-02T14:05:00.000Z"
          ),

        attempts:
          1,

        lastError:
          null,

        providerSessionPresent:
          true,
      }
    );

    assert.equal(
      "stripeIdentityVerificationSessionId" in
        evidence.verification,
      false
    );
  }
);

test(
  "maps the canonical active guest passcode grant and access closure counts",
  async () => {
    const {
      tx,
    } = createMockTransaction();

    const evidence =
      await loadGuestJourneyEvidence(
        tx,
        "reservation-1",
        NOW
      );

    assert.equal(
      evidence.access
        .canonicalGuestGrant
        ?.id,
      "grant-active"
    );

    assert.equal(
      evidence.access
        .canonicalGuestGrant
        ?.ttlockKeyboardPwdIdPresent,
      true
    );

    assert.equal(
      evidence.access
        .canonicalGuestGrant
        ?.secureAccessCodePresent,
      true
    );

    assert.equal(
      evidence.access
        .canonicalGuestGrantCandidateCount,
      1
    );

    assert.equal(
      evidence.access
        .guestGrantsOpen,
      1
    );

    assert.equal(
      evidence.access
        .guestGrantsRevoked,
      1
    );
  }
);

test(
  "preserves multiple canonical active grant candidates for evaluator inconsistency detection",
  async () => {
    const reservation =
      createBaseReservation();

    reservation.accessGrants.unshift({
      id:
        "grant-active-2",

      method:
        AccessMethod
          .PASSCODE_TIMEBOUND,

      status:
        AccessStatus.ACTIVE,

      startsAt:
        new Date(
          "2026-08-10T14:01:00.000Z"
        ),

      endsAt:
        CHECK_OUT,

      ttlockKeyboardPwdId:
        999999,

      secureAccessCode: {
        id:
          "access-code-2",

        accessCodeEnc:
          "another-secret",
      },
    });

    const {
      tx,
    } = createMockTransaction({
      reservation,
    });

    const evidence =
      await loadGuestJourneyEvidence(
        tx,
        "reservation-1",
        NOW
      );

    assert.equal(
      evidence.access
        .canonicalGuestGrantCandidateCount,
      2
    );

    assert.ok(
      evidence.access
        .canonicalGuestGrant
    );
  }
);

test(
  "counts unresolved guest NFC lifecycle states while ignoring ENDED assignments",
  async () => {
    const reservation =
      createBaseReservation();

    reservation.NfcAssignment.push(
      {
        id:
          "nfc-provisioning",

        status:
          NfcAssignmentStatus
            .PROVISIONING,
      },

      {
        id:
          "nfc-failed",

        status:
          NfcAssignmentStatus
            .FAILED,
      }
    );

    const {
      tx,
    } = createMockTransaction({
      reservation,
    });

    const evidence =
      await loadGuestJourneyEvidence(
        tx,
        "reservation-1",
        NOW
      );

    assert.equal(
      evidence.access
        .guestNfcScheduled,
      1
    );

    assert.equal(
      evidence.access
        .guestNfcProvisioning,
      1
    );

    assert.equal(
      evidence.access
        .guestNfcActive,
      1
    );

    assert.equal(
      evidence.access
        .guestNfcFailed,
      1
    );
  }
);

test(
  "keeps only the latest bounded dispatch outcome without loading message bodies or recipients",
  async () => {
    const reservation =
      createBaseReservation();

    reservation.messageDispatchLogs = [
      {
        id: "dispatch-new",
        type: "PRECHECKIN",
        channel: "sms",
        status: "SENT",
        createdAt: new Date(
          "2026-08-06T17:00:00.000Z"
        ),
      },
      {
        id: "dispatch-old",
        type: "PRECHECKIN",
        channel: "sms",
        status: "FAILED",
        createdAt: new Date(
          "2026-08-06T16:00:00.000Z"
        ),
      },
    ];

    const {
      tx,
      calls,
    } = createMockTransaction({
      reservation,
    });

    const evidence =
      await loadGuestJourneyEvidence(
        tx,
        "reservation-1",
        NOW
      );

    assert.deepEqual(
      evidence.communications.signals,
      [
        {
          communicationType:
            "PRECHECKIN",

          channel:
            "sms",

          status:
            "SENT",

          retryCount:
            0,

          lastError:
            null,
        },
      ]
    );

    const dispatchSelection =
      calls.reservationFindUnique[0]
        .select.messageDispatchLogs;

    assert.equal(
      dispatchSelection.take,
      100
    );

    assert.equal(
      "body" in dispatchSelection.select,
      false
    );

    assert.equal(
      "to" in dispatchSelection.select,
      false
    );

    assert.equal(
      "from" in dispatchSelection.select,
      false
    );
  }
);

test(
  "returns an explicit missing persisted journey instead of synthesizing one",
  async () => {
    const reservation =
      createBaseReservation();

    reservation.guestJourney =
      null;

    const {
      tx,
    } = createMockTransaction({
      reservation,
    });

    const evidence =
      await loadGuestJourneyEvidence(
        tx,
        "reservation-1",
        NOW
      );

    assert.deepEqual(
      evidence.persistedJourney,
      {
        exists:
          false,

        id:
          null,

        currentState:
          null,

        stateChangedAt:
          null,

        verificationCompletedAt:
          null,

        accessScheduledAt:
          null,

        readyForArrivalAt:
          null,

        stayActiveAt:
          null,

        checkoutDueAt:
          null,

        completedAt:
          null,

        cancelledAt:
          null,
      }
    );
  }
);

test(
  "maps only already-selected active coordination intents without exposing payloads or lease tokens",
  async () => {
    const {
      tx,
    } = createMockTransaction();

    const evidence =
      await loadGuestJourneyEvidence(
        tx,
        "reservation-1",
        NOW
      );

    assert.equal(
      evidence.activeIntents.length,
      1
    );

    assert.equal(
      evidence.activeIntents[0]
        .intentType,
      "REQUEST_ACCESS_PROVISIONING"
    );

    assert.equal(
      evidence.activeIntents[0]
        .targetEngine,
      "ACCESS"
    );

    const serialized =
      JSON.stringify(
        evidence.activeIntents[0]
      );

    assert.equal(
      serialized.includes(
        "payload"
      ),
      false
    );

    assert.equal(
      serialized.includes(
        "leaseToken"
      ),
      false
    );
  }
);

test(
  "fails closed when a persisted active intent contains an unregistered target Engine",
  async () => {
    const reservation =
      createBaseReservation();

    reservation
      .guestJourneyCoordinationIntents[0]
      .targetEngine =
      "UnknownEngine";

    const {
      tx,
    } = createMockTransaction({
      reservation,
    });

    await assert.rejects(
      loadGuestJourneyEvidence(
        tx,
        "reservation-1",
        NOW
      ),

      /GUEST_JOURNEY_EVIDENCE_INVALID_TARGET_ENGINE/
    );
  }
);

test(
  "fails closed when active intent evidence exceeds the bounded contract",
  async () => {
    const reservation =
      createBaseReservation();
    const template =
      reservation
        .guestJourneyCoordinationIntents[0];

    reservation
      .guestJourneyCoordinationIntents =
      Array.from(
        { length: 101 },
        (_, index) => ({
          ...template,
          id: `intent-${index}`,
          intentKey:
            `intent-key-${index}`,
        })
      );

    const { tx } =
      createMockTransaction({
        reservation,
      });

    await assert.rejects(
      loadGuestJourneyEvidence(
        tx,
        "reservation-1",
        NOW
      ),
      /ACTIVE_INTENT_LIMIT_EXCEEDED/
    );
  }
);

test(
  "rejects an invalid evaluation time before querying persistence",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction();

    await assert.rejects(
      loadGuestJourneyEvidence(
        tx,
        "reservation-1",
        new Date("invalid")
      ),

      /now must be a valid Date/
    );

    assert.equal(
      calls
        .reservationFindUnique
        .length,
      0
    );
  }
);

test(
  "rejects a missing reservation with one bounded reservation query",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      reservation:
        null,
    });

    await assert.rejects(
      loadGuestJourneyEvidence(
        tx,
        "reservation-missing",
        NOW
      ),

      /GUEST_JOURNEY_EVIDENCE_RESERVATION_NOT_FOUND/
    );

    assert.equal(
      calls.reservationFindUnique.length,
      1
    );
  }
);

test(
  "fails closed when organization or property scope does not match",
  async () => {
    const { tx } = createMockTransaction();

    await assert.rejects(
      loadGuestJourneyEvidence(
        tx,
        "reservation-1",
        NOW,
        {
          organizationId: "organization-other",
          propertyId: "property-1",
        }
      ),
      /GUEST_JOURNEY_EVIDENCE_SCOPE_MISMATCH/
    );
  }
);
