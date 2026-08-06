import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestJourneyCoordinationIntentStatus,
} from "@prisma/client";

import {
  processGuestJourneyComplianceIntent,
} from "./guest-journey-compliance-intent.service";

const NOW =
  new Date(
    "2026-08-06T22:00:00.000Z"
  );

function createAgreementSnapshot() {
  return {
    agreementId:
      "agreement-1",

    propertyId:
      "property-1",

    version:
      "v1",

    language:
      "en",

    title:
      "Guest Agreement",

    agreementText:
      "Agreement text",

    rules: [],

    guestFacingSummary:
      null,

    requiresIdentityVerification:
      true,

    requiresAgreementSignature:
      true,

    capturedAt:
      "2026-08-06T20:00:00.000Z",
  };
}

function createCancellationSnapshot() {
  return {
    policyId:
      "policy-1",

    name:
      "Flexible",

    type:
      "FLEXIBLE",

    source:
      "PROPERTY_POLICY",

    guestSelfCancellationEnabled:
      true,

    autoRefundEligibleCancellations:
      true,

    requireHostApprovalOutsidePolicy:
      false,

    freeCancellationHoursBeforeCheckIn:
      24,

    refundBasis:
      "TOTAL_AMOUNT",

    refundPercentBeforeDeadline:
      100,

    refundPercentAfterDeadline:
      0,

    refundRules: [],

    nonRefundableScenarios: [],

    guestFacingSummary:
      "Flexible cancellation",

    cleaningFeeRefundable:
      true,

    amenitiesRefundable:
      true,

    taxesRefundable:
      true,

    nonRefundableDiscountPercent:
      null,

    description:
      null,

    snapshotAt:
      "2026-08-06T20:00:00.000Z",
  };
}

function createBaseIntentRecord({
  intentType =
    "REQUEST_REQUIREMENTS_SNAPSHOT",

  targetEngine =
    "Compliance",
}: {
  intentType?: string;
  targetEngine?: string;
} = {}) {
  return {
    id:
      "intent-1",

    intentKey:
      "guest-journey-intent:" +
      "a".repeat(64),

    reservationId:
      "reservation-1",

    journeyId:
      "journey-1",

    contractVersion:
      "guest_journey_coordination_intent_v1",

    intentType,

    targetEngine,

    reasonCode:
      "REQUIREMENTS_SNAPSHOT_MISSING",

    expectedOutcomeCode:
      "REQUIREMENTS_SNAPSHOTS_PRESENT",

    evidenceFingerprint:
      "b".repeat(64),

    status:
      GuestJourneyCoordinationIntentStatus
        .PENDING as
        GuestJourneyCoordinationIntentStatus,

    claimCount: 0,

    leaseToken:
      null as string | null,

    claimedAt:
      null as Date | null,

    leaseExpiresAt:
      null as Date | null,

    lastAttemptAt:
      null as Date | null,

    nextActionAt:
      null as Date | null,

    succeededAt:
      null as Date | null,

    exhaustedAt:
      null as Date | null,

    supersededAt:
      null as Date | null,

    outcomeEvidenceFingerprint:
      null as string | null,

    lastError:
      null as string | null,

    createdAt:
      new Date(
        "2026-08-06T21:00:00.000Z"
      ),

    updatedAt:
      new Date(
        "2026-08-06T21:00:00.000Z"
      ),
  };
}

function applyUpdateData(
  record: Record<string, any>,
  data: Record<string, any>
) {
  for (
    const [key, value] of
    Object.entries(data)
  ) {
    if (
      value &&
      typeof value === "object" &&
      "increment" in value
    ) {
      record[key] =
        Number(
          record[key] ?? 0
        ) +
        Number(
          (value as any)
            .increment
        );

      continue;
    }

    record[key] =
      value;
  }
}

type MockOptions = {
  intentType?: string;
  targetEngine?: string;

  intentUpdateCounts?:
    number[];

  reservationUpdateCounts?:
    number[];

  reservation?:
    | {
        id: string;
        propertyId: string;

        guestAgreementSnapshot:
          unknown;

        cancellationPolicySnapshot:
          unknown;

        cancellationPolicyId:
          string | null;
      }
    | null;
};

function createMockPrisma(
  options: MockOptions = {}
) {
  const calls = {
    intentFindUnique:
      [] as any[],

    intentFindUniqueOrThrow:
      [] as any[],

    intentUpdateMany:
      [] as any[],

    reservationFindUnique:
      [] as any[],

    reservationUpdateMany:
      [] as any[],
  };

  const currentIntent =
    createBaseIntentRecord({
      intentType:
        options.intentType,

      targetEngine:
        options.targetEngine,
    });

  let currentReservation =
    options.reservation ===
    undefined
      ? {
          id:
            "reservation-1",

          propertyId:
            "property-1",

          guestAgreementSnapshot:
            createAgreementSnapshot(),

          cancellationPolicySnapshot:
            createCancellationSnapshot(),

          cancellationPolicyId:
            "policy-1",
        }
      : options.reservation;

  const intentUpdateCounts = [
    ...(
      options
        .intentUpdateCounts ??
      [1, 1]
    ),
  ];

  const reservationUpdateCounts = [
    ...(
      options
        .reservationUpdateCounts ??
      [1]
    ),
  ];

  const prisma = {
    guestJourneyCoordinationIntent: {
      findUniqueOrThrow:
        async (
          args: any
        ) => {
          calls
            .intentFindUniqueOrThrow
            .push(args);

          return {
            ...currentIntent,
          };
        },

      findUnique:
        async (
          args: any
        ) => {
          calls
            .intentFindUnique
            .push(args);

          return {
            id:
              currentIntent.id,

            reservationId:
              currentIntent
                .reservationId,

            intentType:
              currentIntent
                .intentType,

            targetEngine:
              currentIntent
                .targetEngine,
          };
        },

      updateMany:
        async (
          args: any
        ) => {
          calls
            .intentUpdateMany
            .push(args);

          const count =
            intentUpdateCounts
              .length > 0
              ? intentUpdateCounts
                  .shift()!
              : 1;

          if (count === 1) {
            applyUpdateData(
              currentIntent,
              args.data
            );
          }

          return {
            count,
          };
        },
    },

    reservation: {
      findUnique:
        async (
          args: any
        ) => {
          calls
            .reservationFindUnique
            .push(args);

          if (
            !currentReservation
          ) {
            return null;
          }

          return {
            ...currentReservation,
          };
        },

      updateMany:
        async (
          args: any
        ) => {
          calls
            .reservationUpdateMany
            .push(args);

          const count =
            reservationUpdateCounts
              .length > 0
              ? reservationUpdateCounts
                  .shift()!
              : 1;

          if (
            count === 1 &&
            currentReservation
          ) {
            currentReservation = {
              ...currentReservation,
              ...args.data,
            };
          }

          return {
            count,
          };
        },
    },
  };

  return {
    prisma:
      prisma as any,

    calls,

    currentIntent,

    getReservation:
      () =>
        currentReservation,

    setAgreementSnapshot:
      (
        value:
          unknown
      ) => {
        if (
          currentReservation
        ) {
          currentReservation = {
            ...currentReservation,

            guestAgreementSnapshot:
              value,
          };
        }
      },

    setCancellationSnapshot:
      (
        value:
          unknown,
        policyId:
          string | null =
          null
      ) => {
        if (
          currentReservation
        ) {
          currentReservation = {
            ...currentReservation,

            cancellationPolicySnapshot:
              value,

            cancellationPolicyId:
              policyId,
          };
        }
      },
  };
}

test(
  "captures both missing legal snapshots and waits for Reconciler evidence verification",
  async () => {
    const mock =
      createMockPrisma({
        reservation: {
          id:
            "reservation-1",

          propertyId:
            "property-1",

          guestAgreementSnapshot:
            null,

          cancellationPolicySnapshot:
            null,

          cancellationPolicyId:
            null,
        },
      });

    let agreementCalls = 0;
    let cancellationCalls = 0;

    const result =
      await processGuestJourneyComplianceIntent(
        mock.prisma,
        {
          intentId:
            "intent-1",

          now:
            NOW,
        },
        {
          ensureAgreementSnapshot:
            (async () => {
              agreementCalls += 1;

              const snapshot =
                createAgreementSnapshot();

              mock
                .setAgreementSnapshot(
                  snapshot
                );

              return {
                ok: true,
                alreadyCaptured:
                  false,
                snapshot,
              };
            }) as any,

          buildCancellationSnapshot:
            (async () => {
              cancellationCalls += 1;

              return createCancellationSnapshot();
            }) as any,
        }
      );

    assert.equal(
      result.claimed,
      true
    );

    assert.equal(
      result.outcome,
      "WAITING_FOR_EVIDENCE"
    );

    assert.equal(
      result.intent.status,
      GuestJourneyCoordinationIntentStatus
        .WAITING_FOR_EVIDENCE
    );

    assert.deepEqual(
      result.workPerformed,
      [
        "GUEST_AGREEMENT_SNAPSHOT_CAPTURED",
        "CANCELLATION_POLICY_SNAPSHOT_CAPTURED",
      ]
    );

    assert.equal(
      agreementCalls,
      1
    );

    assert.equal(
      cancellationCalls,
      1
    );

    assert.equal(
      mock.calls
        .reservationUpdateMany
        .length,
      1
    );

    assert.deepEqual(
      mock.getReservation()
        ?.cancellationPolicySnapshot,
      createCancellationSnapshot()
    );

    assert.equal(
      mock.getReservation()
        ?.cancellationPolicyId,
      "policy-1"
    );
  }
);

test(
  "does not rewrite legal snapshots that are already present",
  async () => {
    const mock =
      createMockPrisma();

    const result =
      await processGuestJourneyComplianceIntent(
        mock.prisma,
        {
          intentId:
            "intent-1",

          now:
            NOW,
        },
        {
          ensureAgreementSnapshot:
            (async () => {
              throw new Error(
                "AGREEMENT_SHOULD_NOT_BE_CALLED"
              );
            }) as any,

          buildCancellationSnapshot:
            (async () => {
              throw new Error(
                "CANCELLATION_SHOULD_NOT_BE_CALLED"
              );
            }) as any,
        }
      );

    assert.equal(
      result.outcome,
      "WAITING_FOR_EVIDENCE"
    );

    assert.deepEqual(
      result.workPerformed,
      []
    );

    assert.equal(
      mock.calls
        .reservationUpdateMany
        .length,
      0
    );
  }
);

test(
  "keeps guest verification human-gated and performs no snapshot or Stripe work",
  async () => {
    const mock =
      createMockPrisma({
        intentType:
          "REQUEST_GUEST_VERIFICATION",
      });

    const result =
      await processGuestJourneyComplianceIntent(
        mock.prisma,
        {
          intentId:
            "intent-1",

          now:
            NOW,
        },
        {
          ensureAgreementSnapshot:
            (async () => {
              throw new Error(
                "GUEST_VERIFICATION_MUST_NOT_CAPTURE_AGREEMENT"
              );
            }) as any,

          buildCancellationSnapshot:
            (async () => {
              throw new Error(
                "GUEST_VERIFICATION_MUST_NOT_BUILD_CANCELLATION"
              );
            }) as any,
        }
      );

    assert.equal(
      result.outcome,
      "WAITING_FOR_EVIDENCE"
    );

    assert.deepEqual(
      result.workPerformed,
      [
        "GUEST_VERIFICATION_AWAITING_GUEST_EVIDENCE",
      ]
    );

    assert.equal(
      mock.calls
        .reservationFindUnique
        .length,
      0
    );

    assert.equal(
      mock.calls
        .reservationUpdateMany
        .length,
      0
    );
  }
);

test(
  "returns CLAIM_NOT_ACQUIRED when coordination compare-and-set loses",
  async () => {
    const mock =
      createMockPrisma({
        intentUpdateCounts:
          [0],
      });

    const result =
      await processGuestJourneyComplianceIntent(
        mock.prisma,
        {
          intentId:
            "intent-1",

          now:
            NOW,
        }
      );

    assert.equal(
      result.claimed,
      false
    );

    assert.equal(
      result.outcome,
      "CLAIM_NOT_ACQUIRED"
    );

    assert.equal(
      result.reservationId,
      null
    );

    assert.deepEqual(
      result.workPerformed,
      []
    );

    assert.equal(
      mock.calls
        .reservationFindUnique
        .length,
      0
    );
  }
);

test(
  "exhausts requirements work when the reservation no longer exists",
  async () => {
    const mock =
      createMockPrisma({
        reservation:
          null,
      });

    const result =
      await processGuestJourneyComplianceIntent(
        mock.prisma,
        {
          intentId:
            "intent-1",

          now:
            NOW,
        }
      );

    assert.equal(
      result.outcome,
      "EXHAUSTED"
    );

    assert.equal(
      result.exhaustedReason,
      "GUEST_JOURNEY_COMPLIANCE_RESERVATION_NOT_FOUND"
    );

    assert.equal(
      result.intent.status,
      GuestJourneyCoordinationIntentStatus
        .EXHAUSTED
    );
  }
);

test(
  "never overwrites an existing malformed Guest Agreement snapshot",
  async () => {
    const mock =
      createMockPrisma({
        reservation: {
          id:
            "reservation-1",

          propertyId:
            "property-1",

          guestAgreementSnapshot:
            {
              agreementId:
                "broken",
            },

          cancellationPolicySnapshot:
            createCancellationSnapshot(),

          cancellationPolicyId:
            "policy-1",
        },
      });

    let agreementCalls = 0;

    const result =
      await processGuestJourneyComplianceIntent(
        mock.prisma,
        {
          intentId:
            "intent-1",

          now:
            NOW,
        },
        {
          ensureAgreementSnapshot:
            (async () => {
              agreementCalls += 1;

              throw new Error(
                "MUST_NOT_REWRITE"
              );
            }) as any,
        }
      );

    assert.equal(
      result.outcome,
      "EXHAUSTED"
    );

    assert.equal(
      result.exhaustedReason,
      "GUEST_JOURNEY_COMPLIANCE_EXISTING_AGREEMENT_SNAPSHOT_INVALID"
    );

    assert.equal(
      agreementCalls,
      0
    );
  }
);

test(
  "exhausts when no active Guest Agreement can be captured",
  async () => {
    const mock =
      createMockPrisma({
        reservation: {
          id:
            "reservation-1",

          propertyId:
            "property-1",

          guestAgreementSnapshot:
            null,

          cancellationPolicySnapshot:
            createCancellationSnapshot(),

          cancellationPolicyId:
            "policy-1",
        },
      });

    const result =
      await processGuestJourneyComplianceIntent(
        mock.prisma,
        {
          intentId:
            "intent-1",

          now:
            NOW,
        },
        {
          ensureAgreementSnapshot:
            (async () => ({
              ok:
                false,

              alreadyCaptured:
                false,

              reason:
                "ACTIVE_PROPERTY_GUEST_AGREEMENT_NOT_FOUND",

              snapshot:
                null,
            })) as any,
        }
      );

    assert.equal(
      result.outcome,
      "EXHAUSTED"
    );

    assert.equal(
      result.exhaustedReason,
      "ACTIVE_PROPERTY_GUEST_AGREEMENT_NOT_FOUND"
    );
  }
);

test(
  "does not trust a successful agreement return unless the snapshot was actually persisted",
  async () => {
    const mock =
      createMockPrisma({
        reservation: {
          id:
            "reservation-1",

          propertyId:
            "property-1",

          guestAgreementSnapshot:
            null,

          cancellationPolicySnapshot:
            createCancellationSnapshot(),

          cancellationPolicyId:
            "policy-1",
        },
      });

    const result =
      await processGuestJourneyComplianceIntent(
        mock.prisma,
        {
          intentId:
            "intent-1",

          now:
            NOW,
        },
        {
          ensureAgreementSnapshot:
            (async () => ({
              ok:
                true,

              alreadyCaptured:
                false,

              snapshot:
                createAgreementSnapshot(),
            })) as any,
        }
      );

    assert.equal(
      result.outcome,
      "EXHAUSTED"
    );

    assert.equal(
      result.exhaustedReason,
      "GUEST_JOURNEY_COMPLIANCE_AGREEMENT_SNAPSHOT_NOT_PERSISTED"
    );
  }
);

test(
  "never overwrites an existing malformed Cancellation Policy snapshot",
  async () => {
    const mock =
      createMockPrisma({
        reservation: {
          id:
            "reservation-1",

          propertyId:
            "property-1",

          guestAgreementSnapshot:
            createAgreementSnapshot(),

          cancellationPolicySnapshot:
            [],

          cancellationPolicyId:
            null,
        },
      });

    let cancellationCalls = 0;

    const result =
      await processGuestJourneyComplianceIntent(
        mock.prisma,
        {
          intentId:
            "intent-1",

          now:
            NOW,
        },
        {
          buildCancellationSnapshot:
            (async () => {
              cancellationCalls += 1;

              throw new Error(
                "MUST_NOT_REWRITE"
              );
            }) as any,
        }
      );

    assert.equal(
      result.outcome,
      "EXHAUSTED"
    );

    assert.equal(
      result.exhaustedReason,
      "GUEST_JOURNEY_COMPLIANCE_EXISTING_CANCELLATION_SNAPSHOT_INVALID"
    );

    assert.equal(
      cancellationCalls,
      0
    );
  }
);

test(
  "exhausts instead of claiming success when Cancellation Policy persistence loses without replacement evidence",
  async () => {
    const mock =
      createMockPrisma({
        reservation: {
          id:
            "reservation-1",

          propertyId:
            "property-1",

          guestAgreementSnapshot:
            createAgreementSnapshot(),

          cancellationPolicySnapshot:
            null,

          cancellationPolicyId:
            null,
        },

        reservationUpdateCounts:
          [0],
      });

    const result =
      await processGuestJourneyComplianceIntent(
        mock.prisma,
        {
          intentId:
            "intent-1",

          now:
            NOW,
        },
        {
          buildCancellationSnapshot:
            (async () =>
              createCancellationSnapshot()) as any,
        }
      );

    assert.equal(
      result.outcome,
      "EXHAUSTED"
    );

    assert.equal(
      result.exhaustedReason,
      "GUEST_JOURNEY_COMPLIANCE_CANCELLATION_SNAPSHOT_NOT_PERSISTED"
    );

    assert.deepEqual(
      result.workPerformed,
      []
    );
  }
);

test(
  "exhausts a registered intent that does not belong to the Compliance owner contract",
  async () => {
    const mock =
      createMockPrisma({
        intentType:
          "REQUEST_ACCESS_PROVISIONING",

        targetEngine:
          "Compliance",
      });

    const result =
      await processGuestJourneyComplianceIntent(
        mock.prisma,
        {
          intentId:
            "intent-1",

          now:
            NOW,
        }
      );

    assert.equal(
      result.outcome,
      "EXHAUSTED"
    );

    assert.equal(
      result.exhaustedReason,
      "GUEST_JOURNEY_COMPLIANCE_UNSUPPORTED_INTENT_TYPE:REQUEST_ACCESS_PROVISIONING"
    );

    assert.equal(
      mock.calls
        .reservationFindUnique
        .length,
      0
    );
  }
);

test(
  "rejects an invalid evaluation time before claiming an intent",
  async () => {
    const mock =
      createMockPrisma();

    await assert.rejects(
      () =>
        processGuestJourneyComplianceIntent(
          mock.prisma,
          {
            intentId:
              "intent-1",

            now:
              new Date(
                "invalid"
              ),
          }
        ),
      /now must be a valid Date/
    );

    assert.equal(
      mock.calls
        .intentUpdateMany
        .length,
      0
    );
  }
);

test(
  "rejects a blank intent id before persistence access",
  async () => {
    const mock =
      createMockPrisma();

    await assert.rejects(
      () =>
        processGuestJourneyComplianceIntent(
          mock.prisma,
          {
            intentId:
              "   ",

            now:
              NOW,
          }
        ),
      /intentId is required/
    );

    assert.equal(
      mock.calls
        .intentUpdateMany
        .length,
      0
    );
  }
);