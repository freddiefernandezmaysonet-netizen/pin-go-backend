import assert from "node:assert/strict";
import test from "node:test";

import {
  AccessMethod,
  AccessStatus,
  GuestAccessMode,
  GuestAccessReleaseStatus,
  GuestJourneyCoordinationIntentStatus,
  GuestJourneyState,
  PaymentState,
  ReservationStatus,
} from "@prisma/client";

import {
  reconcileGuestJourney,
  reconcileGuestJourneyInTransaction,
} from "./guest-journey-reconciler.service";

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

const VERIFIED_AT =
  new Date(
    "2026-08-02T14:05:00.000Z"
  );

const RELEASED_AT =
  new Date(
    "2026-08-06T16:00:00.000Z"
  );

const ACTIVE_INTENT_STATUSES =
  new Set([
    GuestJourneyCoordinationIntentStatus
      .PENDING,

    GuestJourneyCoordinationIntentStatus
      .CLAIMED,

    GuestJourneyCoordinationIntentStatus
      .WAITING_FOR_EVIDENCE,

    GuestJourneyCoordinationIntentStatus
      .RETRYABLE,
  ]);

type State = {
  reservation:
    Record<string, any>;

  journey:
    Record<string, any> | null;

  intents:
    Record<string, any>[];

  audits:
    Record<string, any>[];

  messageLogs:
    Record<string, any>[];

  journeyCreateManyCalls:
    any[];

  journeyUpdateManyCalls:
    any[];

  intentCreateManyCalls:
    any[];

  intentUpdateManyCalls:
    any[];

  advisoryLockCalls:
    any[];

  loseNextJourneyCas:
    boolean;

  casWinnerState:
    GuestJourneyState | null;
};

function createJourney(
  currentState:
    GuestJourneyState =
      GuestJourneyState
        .ACCESS_SCHEDULED
): Record<string, any> {
  return {
    id:
      "journey-1",

    reservationId:
      "reservation-1",

    currentState,

    stateChangedAt:
      RELEASED_AT,

    verificationCompletedAt:
      [
        GuestJourneyState
          .VERIFICATION_COMPLETED,

        GuestJourneyState
          .ACCESS_SCHEDULED,

        GuestJourneyState
          .READY_FOR_ARRIVAL,

        GuestJourneyState
          .STAY_ACTIVE,

        GuestJourneyState
          .CHECKOUT_DUE,

        GuestJourneyState
          .JOURNEY_COMPLETED,
      ].some((state) => state === currentState)
        ? VERIFIED_AT
        : null,

    accessScheduledAt:
      [
        GuestJourneyState
          .ACCESS_SCHEDULED,

        GuestJourneyState
          .READY_FOR_ARRIVAL,

        GuestJourneyState
          .STAY_ACTIVE,

        GuestJourneyState
          .CHECKOUT_DUE,

        GuestJourneyState
          .JOURNEY_COMPLETED,
      ].some((state) => state === currentState)
        ? RELEASED_AT
        : null,

    readyForArrivalAt:
      [
        GuestJourneyState
          .READY_FOR_ARRIVAL,

        GuestJourneyState
          .STAY_ACTIVE,

        GuestJourneyState
          .CHECKOUT_DUE,

        GuestJourneyState
          .JOURNEY_COMPLETED,
      ].some((state) => state === currentState)
        ? new Date(
            "2026-08-10T14:00:00.000Z"
          )
        : null,

    stayActiveAt:
      [
        GuestJourneyState
          .STAY_ACTIVE,

        GuestJourneyState
          .CHECKOUT_DUE,

        GuestJourneyState
          .JOURNEY_COMPLETED,
      ].some((state) => state === currentState)
        ? CHECK_IN
        : null,

    checkoutDueAt:
      [
        GuestJourneyState
          .CHECKOUT_DUE,

        GuestJourneyState
          .JOURNEY_COMPLETED,
      ].some((state) => state === currentState)
        ? CHECK_OUT
        : null,

    completedAt:
      currentState ===
      GuestJourneyState
        .JOURNEY_COMPLETED
        ? NOW
        : null,

    cancelledAt:
      currentState ===
      GuestJourneyState
        .JOURNEY_CANCELLED
        ? NOW
        : null,
  };
}

function createBaseReservation():
  Record<string, any> {
  return {
    id:
      "reservation-1",

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
      "en",

    checkIn:
      CHECK_IN,

    checkOut:
      CHECK_OUT,

    cancelledAt:
      null,

    guestToken:
      "secret-token",

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
        "en",

      title:
        "Agreement",

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
      accepted:
        true,

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
      type:
        "FLEXIBLE",
    },

    identityVerificationRequiredSnapshot:
      true,

    verificationStatus:
      "COMPLETED",

    verifiedAt:
      VERIFIED_AT,

    identityVerificationAttempts:
      1,

    stripeIdentityVerificationLastError:
      null,

    stripeIdentityVerificationSessionId:
      "identity-session-secret",

    guestAccessModeSnapshot:
      GuestAccessMode.PASSCODE_ONLY,

    guestAccessReleaseStatus:
      GuestAccessReleaseStatus
        .RELEASED,

    guestAccessEligibleAt:
      RELEASED_AT,

    guestAccessReleasedAt:
      RELEASED_AT,

    property: {
      organizationId:
        "organization-1",
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
          RELEASED_AT,

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
    ],

    NfcAssignment: [],

    messageDispatchLogs: [],
  };
}

function createIntent(
  overrides:
    Record<string, any> = {}
): Record<string, any> {
  const createdAt =
    new Date(
      "2026-08-06T17:00:00.000Z"
    );

  return {
    id:
      overrides.id ??
      "intent-existing",

    intentKey:
      overrides.intentKey ??
      "guest-journey-intent:existing",

    reservationId:
      "reservation-1",

    journeyId:
      "journey-1",

    contractVersion:
      "guest_journey_coordination_intent_v1",

    intentType:
      "REQUEST_ACCESS_PROVISIONING",

    targetEngine:
      "Access",

    reasonCode:
      "ACCESS_PROVISIONING_INCOMPLETE",

    expectedOutcomeCode:
      "SECURE_GUEST_ACCESS_ACTIVE",

    evidenceFingerprint:
      "b".repeat(64),

    payload:
      null,

    status:
      GuestJourneyCoordinationIntentStatus
        .PENDING,

    claimCount:
      0,

    leaseToken:
      null,

    claimedAt:
      null,

    leaseExpiresAt:
      null,

    lastAttemptAt:
      null,

    nextActionAt:
      null,

    succeededAt:
      null,

    exhaustedAt:
      null,

    supersededAt:
      null,

    outcomeEvidenceFingerprint:
      null,

    lastError:
      null,

    createdAt,

    updatedAt:
      createdAt,

    ...overrides,
  };
}

function createState(
  options?: {
    journey?:
      Record<string, any> | null;

    reservation?:
      Record<string, any>;

    intents?:
      Record<string, any>[];

    loseNextJourneyCas?:
      boolean;

    casWinnerState?:
      GuestJourneyState | null;
  }
): State {
  return {
    reservation:
      options?.reservation ??
      createBaseReservation(),

    journey:
      options &&
      "journey" in options
        ? options.journey ?? null
        : createJourney(),

    intents:
      options?.intents ?? [],

    audits: [],

    messageLogs: [],

    journeyCreateManyCalls: [],

    journeyUpdateManyCalls: [],

    intentCreateManyCalls: [],

    intentUpdateManyCalls: [],

    advisoryLockCalls: [],

    loseNextJourneyCas:
      options
        ?.loseNextJourneyCas ??
      false,

    casWinnerState:
      options
        ?.casWinnerState ??
      null,
  };
}

function projectJourneyForEvidence(
  state: State
) {
  if (!state.journey) {
    return null;
  }

  return {
    id:
      state.journey.id,

    currentState:
      state.journey.currentState,

    stateChangedAt:
      state.journey.stateChangedAt,

    verificationCompletedAt:
      state.journey
        .verificationCompletedAt,

    accessScheduledAt:
      state.journey
        .accessScheduledAt,

    readyForArrivalAt:
      state.journey
        .readyForArrivalAt,

    stayActiveAt:
      state.journey
        .stayActiveAt,

    checkoutDueAt:
      state.journey
        .checkoutDueAt,

    completedAt:
      state.journey
        .completedAt,

    cancelledAt:
      state.journey
        .cancelledAt,
  };
}

function projectIntentForEvidence(
  intent:
    Record<string, any>
) {
  return {
    id:
      intent.id,

    intentKey:
      intent.intentKey,

    intentType:
      intent.intentType,

    targetEngine:
      intent.targetEngine,

    status:
      intent.status,

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

function matchesJourneyWhere(
  journey:
    Record<string, any>,
  where:
    Record<string, any>
) {
  if (
    where.id !== undefined &&
    where.id !== journey.id
  ) {
    return false;
  }

  if (
    where.reservationId !==
      undefined &&
    where.reservationId !==
      journey.reservationId
  ) {
    return false;
  }

  if (
    where.currentState !==
      undefined &&
    where.currentState !==
      journey.currentState
  ) {
    return false;
  }

  const nullableFields = [
    "verificationCompletedAt",
    "accessScheduledAt",
    "readyForArrivalAt",
    "stayActiveAt",
    "checkoutDueAt",
    "completedAt",
    "cancelledAt",
  ];

  for (
    const field of
    nullableFields
  ) {
    if (
      field in where &&
      where[field] === null &&
      journey[field] !== null
    ) {
      return false;
    }
  }

  return true;
}

function matchesIntentWhere(
  intent:
    Record<string, any>,
  where:
    Record<string, any>
) {
  if (
    where.id !== undefined &&
    where.id !== intent.id
  ) {
    return false;
  }

  if (
    where.reservationId !==
      undefined &&
    where.reservationId !==
      intent.reservationId
  ) {
    return false;
  }

  if (
    where.status !== undefined
  ) {
    if (
      typeof where.status ===
        "object" &&
      Array.isArray(
        where.status.in
      )
    ) {
      if (
        !where.status.in.includes(
          intent.status
        )
      ) {
        return false;
      }
    } else if (
      intent.status !==
      where.status
    ) {
      return false;
    }
  }

  if (
    where.evidenceFingerprint
      ?.not !== undefined &&
    intent.evidenceFingerprint ===
      where.evidenceFingerprint.not
  ) {
    return false;
  }

  return true;
}

function createTransaction(
  state: State
) {
  const tx = {
    $executeRawUnsafe:
      async (
        ...args: any[]
      ) => {
        state.advisoryLockCalls
          .push(args);

        return 1;
      },

    reservation: {
      findUnique:
        async () => ({
          ...state.reservation,

          guestJourney:
            projectJourneyForEvidence(
              state
            ),

          guestJourneyCoordinationIntents:
            state.intents
              .filter(
                (intent) =>
                  ACTIVE_INTENT_STATUSES
                    .has(
                      intent.status
                    )
              )
              .map(
                projectIntentForEvidence
              ),
        }),
    },

    messageLog: {
      findMany:
        async () =>
          state.messageLogs,
    },

    guestJourney: {
      findUnique:
        async (
          args: any
        ) => {
          if (!state.journey) {
            return null;
          }

          if (
            args.where
              ?.reservationId !==
                undefined &&
            args.where
              .reservationId !==
                state.journey
                  .reservationId
          ) {
            return null;
          }

          if (
            args.where?.id !==
              undefined &&
            args.where.id !==
              state.journey.id
          ) {
            return null;
          }

          return {
            ...state.journey,
          };
        },

      findUniqueOrThrow:
        async (
          args: any
        ) => {
          if (
            !state.journey
          ) {
            throw new Error(
              "Journey not found"
            );
          }

          if (
            args.where?.id !==
              undefined &&
            args.where.id !==
              state.journey.id
          ) {
            throw new Error(
              "Journey not found"
            );
          }

          return {
            ...state.journey,
          };
        },

      createMany:
        async (
          args: any
        ) => {
          state
            .journeyCreateManyCalls
            .push(args);

          if (state.journey) {
            return {
              count: 0,
            };
          }

          const data =
            args.data[0];

          state.journey = {
            id:
              "journey-created",

            reservationId:
              data.reservationId,

            currentState:
              data.currentState,

            stateChangedAt:
              data.stateChangedAt,

            verificationCompletedAt:
              data
                .verificationCompletedAt ??
              null,

            accessScheduledAt:
              data
                .accessScheduledAt ??
              null,

            readyForArrivalAt:
              data
                .readyForArrivalAt ??
              null,

            stayActiveAt:
              data.stayActiveAt ??
              null,

            checkoutDueAt:
              data.checkoutDueAt ??
              null,

            completedAt:
              data.completedAt ??
              null,

            cancelledAt:
              data.cancelledAt ??
              null,
          };

          return {
            count: 1,
          };
        },

      updateMany:
        async (
          args: any
        ) => {
          state
            .journeyUpdateManyCalls
            .push(args);

          if (
            !state.journey ||
            !matchesJourneyWhere(
              state.journey,
              args.where
            )
          ) {
            return {
              count: 0,
            };
          }

          const changesState =
            args.data
              .currentState !==
            undefined;

          if (
            changesState &&
            state
              .loseNextJourneyCas
          ) {
            state
              .loseNextJourneyCas =
              false;

            if (
              state.casWinnerState
            ) {
              state.journey
                .currentState =
                state
                  .casWinnerState;
            }

            return {
              count: 0,
            };
          }

          Object.assign(
            state.journey,
            args.data
          );

          return {
            count: 1,
          };
        },
    },

    guestJourneyCoordinationIntent: {
      createMany:
        async (
          args: any
        ) => {
          state
            .intentCreateManyCalls
            .push(args);

          const data =
            args.data[0];

          const existing =
            state.intents
              .find(
                (intent) =>
                  intent.intentKey ===
                  data.intentKey
              );

          if (existing) {
            return {
              count: 0,
            };
          }

          const created =
            createIntent({
              ...data,

              id:
                `intent-${state.intents.length + 1}`,

              status:
                GuestJourneyCoordinationIntentStatus
                  .PENDING,

              claimCount:
                0,

              createdAt:
                NOW,

              updatedAt:
                NOW,
            });

          state.intents.push(
            created
          );

          return {
            count: 1,
          };
        },

      findUniqueOrThrow:
        async (
          args: any
        ) => {
          const found =
            state.intents
              .find(
                (intent) =>
                  args.where
                    ?.intentKey !==
                    undefined
                    ? intent
                        .intentKey ===
                      args.where
                        .intentKey
                    : intent.id ===
                      args.where?.id
              );

          if (!found) {
            throw new Error(
              "Intent not found"
            );
          }

          return {
            ...found,
          };
        },

      updateMany:
        async (
          args: any
        ) => {
          state
            .intentUpdateManyCalls
            .push(args);

          let count =
            0;

          for (
            const intent of
            state.intents
          ) {
            if (
              !matchesIntentWhere(
                intent,
                args.where
              )
            ) {
              continue;
            }

            Object.assign(
              intent,
              args.data
            );

            count += 1;
          }

          return {
            count,
          };
        },
    },

    apmsAuditEntry: {
      findUnique:
        async (
          args: any
        ) =>
          state.audits
            .find(
              (entry) =>
                entry.decisionId ===
                args.where
                  .decisionId
            ) ??
          null,

      create:
        async (
          args: any
        ) => {
          const created = {
            id:
              `audit-${state.audits.length + 1}`,

            ...args.data,
          };

          state.audits.push(
            created
          );

          return created;
        },
    },
  };

  return tx as any;
}

test(
  "returns NO_ACTION when the persisted journey is aligned with canonical evidence",
  async () => {
    const state =
      createState();

    const result =
      await reconcileGuestJourneyInTransaction(
        createTransaction(
          state
        ),
        "reservation-1",
        NOW
      );

    assert.equal(
      result.evaluation
        .comparison,
      "ALIGNED"
    );

    assert.equal(
      result.finalPersistedState,
      GuestJourneyState
        .ACCESS_SCHEDULED
    );

    assert.deepEqual(
      result.actions.map(
        (action) =>
          action.code
      ),
      [
        "NO_ACTION",
      ]
    );

    assert.equal(
      state
        .journeyUpdateManyCalls
        .length,
      0
    );

    assert.equal(
      state.audits.length,
      0
    );
  }
);

test(
  "reconstructs a missing journey directly at the highest state proven by evidence",
  async () => {
    const state =
      createState({
        journey: null,
      });

    const result =
      await reconcileGuestJourneyInTransaction(
        createTransaction(
          state
        ),
        "reservation-1",
        NOW
      );

    assert.equal(
      result.evaluation
        .comparison,
      "MISSING"
    );

    assert.equal(
      state
        .journeyCreateManyCalls
        .length,
      1
    );

    assert.equal(
      state.journey
        ?.currentState,
      GuestJourneyState
        .ACCESS_SCHEDULED
    );

    assert.equal(
      state.journey
        ?.accessScheduledAt
        ?.getTime(),
      RELEASED_AT.getTime()
    );

    assert.equal(
      state
        .journeyUpdateManyCalls
        .length,
      0
    );

    assert.ok(
      result.actions.some(
        (action) =>
          action.code ===
          "CREATE_JOURNEY_FROM_EVIDENCE"
      )
    );

    assert.equal(
      state.audits.length,
      1
    );
  }
);

test(
  "reconstructs a first-observed cancelled reservation directly as JOURNEY_CANCELLED",
  async () => {
    const reservation =
      createBaseReservation();

    reservation.status =
      ReservationStatus
        .CANCELLED;

    reservation.cancelledAt =
      new Date(
        "2026-08-05T13:00:00.000Z"
      );

    reservation.accessGrants =
      [
        {
          ...reservation
            .accessGrants[0],

          status:
            AccessStatus
              .REVOKED,
        },
      ];

    const state =
      createState({
        reservation,
        journey:
          null,
      });

    await reconcileGuestJourneyInTransaction(
      createTransaction(
        state
      ),
      "reservation-1",
      NOW
    );

    assert.equal(
      state.journey
        ?.currentState,
      GuestJourneyState
        .JOURNEY_CANCELLED
    );

    assert.equal(
      state.journey
        ?.cancelledAt
        ?.getTime(),
      reservation
        .cancelledAt
        .getTime()
    );

    assert.equal(
      state
        .journeyUpdateManyCalls
        .length,
      0
    );
  }
);

test(
  "advances a behind journey through every canonical intermediate state using compare-and-set",
  async () => {
    const state =
      createState({
        journey:
          createJourney(
            GuestJourneyState
              .VERIFICATION_PENDING
          ),
      });

    const result =
      await reconcileGuestJourneyInTransaction(
        createTransaction(
          state
        ),
        "reservation-1",
        NOW
      );

    assert.equal(
      result.evaluation
        .comparison,
      "BEHIND"
    );

    assert.equal(
      result.finalPersistedState,
      GuestJourneyState
        .ACCESS_SCHEDULED
    );

    assert.equal(
      state
        .journeyUpdateManyCalls
        .length,
      2
    );

    assert.equal(
      state
        .journeyUpdateManyCalls[0]
        .data.currentState,
      GuestJourneyState
        .VERIFICATION_COMPLETED
    );

    assert.equal(
      state
        .journeyUpdateManyCalls[1]
        .data.currentState,
      GuestJourneyState
        .ACCESS_SCHEDULED
    );

    assert.equal(
      state.audits.length,
      2
    );
  }
);

test(
  "returns the concurrent winner without overwriting it when a state CAS loses",
  async () => {
    const state =
      createState({
        journey:
          createJourney(
            GuestJourneyState
              .VERIFICATION_COMPLETED
          ),

        loseNextJourneyCas:
          true,

        casWinnerState:
          GuestJourneyState
            .ACCESS_SCHEDULED,
      });

    const result =
      await reconcileGuestJourneyInTransaction(
        createTransaction(
          state
        ),
        "reservation-1",
        NOW
      );

    assert.equal(
      result.finalPersistedState,
      GuestJourneyState
        .ACCESS_SCHEDULED
    );

    assert.equal(
      state.audits.length,
      0
    );
  }
);

test(
  "never silently regresses a journey that is ahead of canonical evidence",
  async () => {
    const state =
      createState({
        journey:
          createJourney(
            GuestJourneyState
              .READY_FOR_ARRIVAL
          ),
      });

    const result =
      await reconcileGuestJourneyInTransaction(
        createTransaction(
          state
        ),
        "reservation-1",
        NOW
      );

    assert.equal(
      result.evaluation
        .comparison,
      "AHEAD_OF_EVIDENCE"
    );

    assert.equal(
      state.journey
        ?.currentState,
      GuestJourneyState
        .READY_FOR_ARRIVAL
    );

    assert.equal(
      state
        .journeyUpdateManyCalls
        .length,
      0
    );

    assert.equal(
      result.actions[0].code,
      "NO_ACTION"
    );
  }
);

test(
  "preserves an immutable terminal state when canonical evidence contradicts it",
  async () => {
    const state =
      createState({
        journey:
          createJourney(
            GuestJourneyState
              .JOURNEY_COMPLETED
          ),
      });

    const result =
      await reconcileGuestJourneyInTransaction(
        createTransaction(
          state
        ),
        "reservation-1",
        NOW
      );

    assert.equal(
      result.evaluation
        .comparison,
      "TERMINAL_CONTRADICTION"
    );

    assert.equal(
      state.journey
        ?.currentState,
      GuestJourneyState
        .JOURNEY_COMPLETED
    );

    assert.equal(
      state
        .journeyUpdateManyCalls
        .length,
      0
    );
  }
);

test(
  "repairs a missing lifecycle timestamp from canonical persisted evidence",
  async () => {
    const journey =
      createJourney(
        GuestJourneyState
          .ACCESS_SCHEDULED
      );

    journey.accessScheduledAt =
      null;

    const state =
      createState({
        journey,
      });

    const result =
      await reconcileGuestJourneyInTransaction(
        createTransaction(
          state
        ),
        "reservation-1",
        NOW
      );

    assert.equal(
      state.journey
        ?.accessScheduledAt
        ?.getTime(),
      RELEASED_AT.getTime()
    );

    assert.ok(
      result.actions.some(
        (action) =>
          action.code ===
          "APPLY_INTERNAL_REPAIR"
      )
    );

    assert.equal(
      state.audits.length,
      1
    );
  }
);

test(
  "verifies a satisfied WAITING intent before obsolete-intent supersession",
  async () => {
    const waitingIntent =
      createIntent({
        status:
          GuestJourneyCoordinationIntentStatus
            .WAITING_FOR_EVIDENCE,

        evidenceFingerprint:
          "b".repeat(64),

        expectedOutcomeCode:
          "SECURE_GUEST_ACCESS_ACTIVE",
      });

    const state =
      createState({
        intents: [
          waitingIntent,
        ],
      });

    const result =
      await reconcileGuestJourneyInTransaction(
        createTransaction(
          state
        ),
        "reservation-1",
        NOW
      );

    assert.equal(
      waitingIntent.status,
      GuestJourneyCoordinationIntentStatus
        .SUCCEEDED
    );

    assert.ok(
      waitingIntent
        .outcomeEvidenceFingerprint
    );

    assert.equal(
      waitingIntent
        .supersededAt,
      null
    );

    assert.ok(
      result.actions.some(
        (action) =>
          action.code ===
          "VERIFY_INTENT_SUCCEEDED"
      )
    );

    assert.equal(
      result.actions.some(
        (action) =>
          action.code ===
          "SUPERSEDE_INTENT"
      ),
      false
    );
  }
);

test(
  "supersedes active coordination intents created from obsolete evidence",
  async () => {
    const obsolete =
      createIntent({
        status:
          GuestJourneyCoordinationIntentStatus
            .PENDING,

        evidenceFingerprint:
          "c".repeat(64),
      });

    const state =
      createState({
        intents: [
          obsolete,
        ],
      });

    const result =
      await reconcileGuestJourneyInTransaction(
        createTransaction(
          state
        ),
        "reservation-1",
        NOW
      );

    assert.equal(
      obsolete.status,
      GuestJourneyCoordinationIntentStatus
        .SUPERSEDED
    );

    assert.equal(
      obsolete
        .supersededAt
        ?.getTime(),
      NOW.getTime()
    );

    assert.ok(
      result.actions.some(
        (action) =>
          action.code ===
          "SUPERSEDE_INTENT"
      )
    );
  }
);

test(
  "creates a durable owner-Engine intent instead of executing Access work directly",
  async () => {
    const reservation =
      createBaseReservation();

    reservation
      .guestAccessReleaseStatus =
      GuestAccessReleaseStatus
        .BLOCKED;

    reservation
      .guestAccessEligibleAt =
      null;

    reservation
      .guestAccessReleasedAt =
      null;

    reservation.accessGrants =
      [];

    const state =
      createState({
        reservation,

        journey:
          createJourney(
            GuestJourneyState
              .VERIFICATION_COMPLETED
          ),
      });

    const result =
      await reconcileGuestJourneyInTransaction(
        createTransaction(
          state
        ),
        "reservation-1",
        NOW
      );

    assert.equal(
      state.intents.length,
      1
    );

    assert.equal(
      state.intents[0]
        .intentType,
      "REQUEST_ACCESS_EVALUATION"
    );

    assert.equal(
      state.intents[0]
        .targetEngine,
      "Access"
    );

    assert.ok(
      result.actions.some(
        (action) =>
          action.code ===
          "ENSURE_COORDINATION_INTENT"
      )
    );
  }
);

test(
  "does not create a duplicate coordination intent on a second reconciliation of identical evidence",
  async () => {
    const reservation =
      createBaseReservation();

    reservation
      .guestAccessReleaseStatus =
      GuestAccessReleaseStatus
        .BLOCKED;

    reservation
      .guestAccessEligibleAt =
      null;

    reservation
      .guestAccessReleasedAt =
      null;

    reservation.accessGrants =
      [];

    const state =
      createState({
        reservation,

        journey:
          createJourney(
            GuestJourneyState
              .VERIFICATION_COMPLETED
          ),
      });

    const tx =
      createTransaction(
        state
      );

    await reconcileGuestJourneyInTransaction(
      tx,
      "reservation-1",
      NOW
    );

    const firstIntentCount =
      state.intents.length;

    const second =
      await reconcileGuestJourneyInTransaction(
        tx,
        "reservation-1",
        NOW
      );

    assert.equal(
      firstIntentCount,
      1
    );

    assert.equal(
      state.intents.length,
      1
    );

    assert.deepEqual(
      second.actions.map(
        (action) =>
          action.code
      ),
      [
        "NO_ACTION",
      ]
    );
  }
);

test(
  "returns WAIT_FOR_OUTCOME_EVIDENCE for a current WAITING intent whose persisted outcome is not yet satisfied",
  async () => {
    const reservation =
      createBaseReservation();

    reservation
      .guestAccessReleaseStatus =
      GuestAccessReleaseStatus
        .BLOCKED;

    reservation
      .guestAccessEligibleAt =
      null;

    reservation
      .guestAccessReleasedAt =
      null;

    reservation.accessGrants =
      [];

    const state =
      createState({
        reservation,

        journey:
          createJourney(
            GuestJourneyState
              .VERIFICATION_COMPLETED
          ),
      });

    const tx =
      createTransaction(
        state
      );

    const first =
      await reconcileGuestJourneyInTransaction(
        tx,
        "reservation-1",
        NOW
      );

    assert.ok(
      first.evaluation
        .evidenceFingerprint
    );

    assert.equal(
      state.intents.length,
      1
    );

    state.intents[0].status =
      GuestJourneyCoordinationIntentStatus
        .WAITING_FOR_EVIDENCE;

    const second =
      await reconcileGuestJourneyInTransaction(
        tx,
        "reservation-1",
        NOW
      );

    assert.ok(
      second.actions.some(
        (action) =>
          action.code ===
          "WAIT_FOR_OUTCOME_EVIDENCE"
      )
    );

    assert.equal(
      state.intents[0].status,
      GuestJourneyCoordinationIntentStatus
        .WAITING_FOR_EVIDENCE
    );
  }
);

test(
  "acquires the canonical PostgreSQL transaction advisory lock before reconciliation",
  async () => {
    const state =
      createState();

    const tx =
      createTransaction(
        state
      );

    const prisma = {
      $transaction:
        async (
          callback: any
        ) =>
          callback(tx),
    } as any;

    const result =
      await reconcileGuestJourney(
        prisma,
        " reservation-1 ",
        {
          now:
            NOW,
        }
      );

    assert.equal(
      result.reservationId,
      "reservation-1"
    );

    assert.equal(
      state
        .advisoryLockCalls
        .length,
      1
    );

    assert.equal(
      state
        .advisoryLockCalls[0][0],
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))"
    );

    assert.equal(
      state
        .advisoryLockCalls[0][1],
      "GUEST_JOURNEY:reservation-1"
    );
  }
);

test(
  "rejects an invalid evaluation time before loading evidence",
  async () => {
    const state =
      createState();

    await assert.rejects(
      reconcileGuestJourneyInTransaction(
        createTransaction(
          state
        ),
        "reservation-1",
        new Date("invalid")
      ),

      /now must be a valid Date/
    );
  }
);