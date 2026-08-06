import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestJourneyCoordinationIntentStatus,
} from "@prisma/client";

import {
  buildGuestJourneyCoordinationIntentKey,
  claimGuestJourneyCoordinationIntent,
  ensureGuestJourneyCoordinationIntent,
  markGuestJourneyCoordinationIntentExhausted,
  markGuestJourneyCoordinationIntentRetryable,
  markGuestJourneyCoordinationIntentSucceeded,
  markGuestJourneyCoordinationIntentWaitingForEvidence,
  supersedeObsoleteGuestJourneyCoordinationIntents,
} from "./guest-journey-coordination-intent.service";

const EVIDENCE_FINGERPRINT =
  "a".repeat(64);

const NEW_EVIDENCE_FINGERPRINT =
  "b".repeat(64);

const OUTCOME_EVIDENCE_FINGERPRINT =
  "c".repeat(64);

const NOW =
  new Date(
    "2026-08-06T18:00:00.000Z"
  );

type MockOptions = {
  journey?:
    | {
        id: string;
        reservationId: string;
      }
    | null;

  createCount?: number;

  updateCounts?: number[];

  initialRecord?: Partial<
    ReturnType<
      typeof createBaseIntentRecord
    >
  >;
};

function createBaseIntentRecord() {
  return {
    id: "intent-1",

    intentKey:
      "guest-journey-intent:" +
      "d".repeat(64),

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
      EVIDENCE_FINGERPRINT,

    status:
      GuestJourneyCoordinationIntentStatus
        .PENDING as GuestJourneyCoordinationIntentStatus,

    claimCount: 0,
    leaseToken: null as string | null,
    claimedAt: null as Date | null,
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
        "2026-08-06T17:00:00.000Z"
      ),

    updatedAt:
      new Date(
        "2026-08-06T17:00:00.000Z"
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
        Number(record[key] ?? 0) +
        Number(value.increment);

      continue;
    }

    record[key] = value;
  }
}

function createMockTransaction(
  options: MockOptions = {}
) {
  const calls = {
    journeyFindUnique:
      [] as any[],

    intentCreateMany:
      [] as any[],

    intentFindUniqueOrThrow:
      [] as any[],

    intentUpdateMany:
      [] as any[],
  };

  const journey =
    options.journey === undefined
      ? {
          id: "journey-1",
          reservationId:
            "reservation-1",
        }
      : options.journey;

  const currentRecord = {
    ...createBaseIntentRecord(),
    ...options.initialRecord,
  };

  const updateCounts = [
    ...(options.updateCounts ?? [1]),
  ];

  const tx = {
    guestJourney: {
      findUnique: async (
        args: any
      ) => {
        calls.journeyFindUnique.push(
          args
        );

        return journey;
      },
    },

    guestJourneyCoordinationIntent:
      {
        createMany: async (
          args: any
        ) => {
          calls.intentCreateMany.push(
            args
          );

          const count =
            options.createCount ?? 1;

          if (count === 1) {
            const data =
              args.data[0];

            Object.assign(
              currentRecord,
              data
            );
          }

          return {
            count,
          };
        },

        findUniqueOrThrow: async (
          args: any
        ) => {
          calls
            .intentFindUniqueOrThrow
            .push(args);

          return {
            ...currentRecord,
          };
        },

        updateMany: async (
          args: any
        ) => {
          calls.intentUpdateMany.push(
            args
          );

          const count =
            updateCounts.length > 0
              ? updateCounts.shift()!
              : 1;

          if (count === 1) {
            applyUpdateData(
              currentRecord,
              args.data
            );
          }

          return {
            count,
          };
        },
      },
  };

  return {
    tx: tx as any,
    calls,
    currentRecord,
  };
}

function createEnsureInput() {
  return {
    reservationId:
      " reservation-1 ",

    journeyId:
      " journey-1 ",

    evidenceFingerprint:
      EVIDENCE_FINGERPRINT
        .toUpperCase(),

    intent: {
      intentType:
        "REQUEST_ACCESS_PROVISIONING" as const,

      targetEngine:
        "Access" as const,

      reasonCode:
        "ACCESS_PROVISIONING_INCOMPLETE",

      expectedOutcomeCode:
        "SECURE_GUEST_ACCESS_ACTIVE",

      payload: {
        lockId: "lock-1",

        reservation: {
          id: "reservation-1",
          sequence: 1,
        },
      },
    },
  };
}

test(
  "builds the same deterministic key regardless of payload object ordering",
  () => {
    const first =
      buildGuestJourneyCoordinationIntentKey(
        createEnsureInput()
      );

    const second =
      buildGuestJourneyCoordinationIntentKey(
        {
          reservationId:
            "reservation-1",

          journeyId:
            "journey-1",

          evidenceFingerprint:
            EVIDENCE_FINGERPRINT,

          intent: {
            intentType:
              "REQUEST_ACCESS_PROVISIONING",

            targetEngine:
              "Access",

            reasonCode:
              "ACCESS_PROVISIONING_INCOMPLETE",

            expectedOutcomeCode:
              "SECURE_GUEST_ACCESS_ACTIVE",

            payload: {
              reservation: {
                sequence: 1,
                id: "reservation-1",
              },

              lockId: "lock-1",
            },
          },
        }
      );

    assert.equal(
      first,
      second
    );

    assert.match(
      first,
      /^guest-journey-intent:[a-f0-9]{64}$/
    );
  }
);

test(
  "changes the deterministic key when the evidence fingerprint changes",
  () => {
    const first =
      buildGuestJourneyCoordinationIntentKey(
        createEnsureInput()
      );

    const second =
      buildGuestJourneyCoordinationIntentKey(
        {
          ...createEnsureInput(),

          evidenceFingerprint:
            NEW_EVIDENCE_FINGERPRINT,
        }
      );

    assert.notEqual(
      first,
      second
    );
  }
);

test(
  "rejects an unregistered coordination intent type",
  () => {
    assert.throws(
      () =>
        buildGuestJourneyCoordinationIntentKey(
          {
            ...createEnsureInput(),

            intent: {
              ...createEnsureInput()
                .intent,

              intentType:
                "DO_UNREGISTERED_WORK" as any,
            },
          }
        ),

      /Unsupported Guest Journey coordination intent type/
    );
  }
);

test(
  "creates a coordination intent idempotently with normalized canonical data",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction();

    const result =
      await ensureGuestJourneyCoordinationIntent(
        tx,
        createEnsureInput()
      );

    assert.equal(
      result.created,
      true
    );

    assert.equal(
      calls
        .journeyFindUnique
        .length,
      1
    );

    assert.equal(
      calls
        .intentCreateMany
        .length,
      1
    );

    const createArgs =
      calls.intentCreateMany[0];

    assert.equal(
      createArgs.skipDuplicates,
      true
    );

    assert.equal(
      createArgs.data.length,
      1
    );

    assert.deepEqual(
      {
        reservationId:
          createArgs.data[0]
            .reservationId,

        journeyId:
          createArgs.data[0]
            .journeyId,

        contractVersion:
          createArgs.data[0]
            .contractVersion,

        intentType:
          createArgs.data[0]
            .intentType,

        targetEngine:
          createArgs.data[0]
            .targetEngine,

        reasonCode:
          createArgs.data[0]
            .reasonCode,

        expectedOutcomeCode:
          createArgs.data[0]
            .expectedOutcomeCode,

        evidenceFingerprint:
          createArgs.data[0]
            .evidenceFingerprint,
      },

      {
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
          EVIDENCE_FINGERPRINT,
      }
    );

    assert.equal(
      result.intent.intentType,
      "REQUEST_ACCESS_PROVISIONING"
    );

    assert.equal(
      result.intent.targetEngine,
      "Access"
    );
  }
);

test(
  "returns the existing intent when a concurrent create wins",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      createCount: 0,
    });

    const result =
      await ensureGuestJourneyCoordinationIntent(
        tx,
        createEnsureInput()
      );

    assert.equal(
      result.created,
      false
    );

    assert.equal(
      calls
        .intentFindUniqueOrThrow
        .length,
      1
    );
  }
);

test(
  "rejects a journey that belongs to another reservation",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      journey: {
        id: "journey-1",
        reservationId:
          "reservation-other",
      },
    });

    await assert.rejects(
      ensureGuestJourneyCoordinationIntent(
        tx,
        createEnsureInput()
      ),

      /does not belong to reservation/
    );

    assert.equal(
      calls
        .intentCreateMany
        .length,
      0
    );
  }
);

test(
  "claims a due intent with a lease token using compare-and-set",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction();

    const result =
      await claimGuestJourneyCoordinationIntent(
        tx,
        {
          intentId:
            " intent-1 ",

          targetEngine:
            "Access",

          now: NOW,

          leaseDurationMs:
            30_000,
        }
      );

    assert.equal(
      result.claimed,
      true
    );

    assert.ok(
      result.leaseToken
    );

    assert.equal(
      result.intent.status,
      GuestJourneyCoordinationIntentStatus
        .CLAIMED
    );

    assert.equal(
      result.intent.claimCount,
      1
    );

    const updateArgs =
      calls.intentUpdateMany[0];

    assert.equal(
      updateArgs.where.id,
      "intent-1"
    );

    assert.equal(
      updateArgs.where
        .targetEngine,
      "Access"
    );

    assert.equal(
      "claimCount" in
        updateArgs.where,
      false
    );

    assert.equal(
      updateArgs.data
        .leaseExpiresAt
        .toISOString(),

      "2026-08-06T18:00:30.000Z"
    );

    assert.equal(
      updateArgs.data
        .claimCount
        .increment,
      1
    );

    assert.deepEqual(
      updateArgs.where.OR[0]
        .status.in,

      [
        GuestJourneyCoordinationIntentStatus
          .PENDING,

        GuestJourneyCoordinationIntentStatus
          .RETRYABLE,
      ]
    );

    assert.equal(
      updateArgs.where.OR[1]
        .status,

      GuestJourneyCoordinationIntentStatus
        .CLAIMED
    );
  }
);

test(
  "does not expose a lease token when the compare-and-set claim loses",
  async () => {
    const {
      tx,
    } = createMockTransaction({
      updateCounts: [0],
    });

    const result =
      await claimGuestJourneyCoordinationIntent(
        tx,
        {
          intentId:
            "intent-1",

          targetEngine:
            "Access",

          now: NOW,
        }
      );

    assert.equal(
      result.claimed,
      false
    );

    assert.equal(
      result.leaseToken,
      null
    );

    assert.equal(
      result.intent.status,
      GuestJourneyCoordinationIntentStatus
        .PENDING
    );
  }
);

test(
  "moves a claimed intent to WAITING_FOR_EVIDENCE and releases its lease",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      initialRecord: {
        status:
          GuestJourneyCoordinationIntentStatus
            .CLAIMED,

        leaseToken:
          "lease-token-1",

        leaseExpiresAt:
          new Date(
            "2026-08-06T18:01:00.000Z"
          ),
      },
    });

    const result =
      await markGuestJourneyCoordinationIntentWaitingForEvidence(
        tx,
        {
          intentId:
            "intent-1",

          leaseToken:
            "lease-token-1",

          now: NOW,
        }
      );

    assert.equal(
      result.transitioned,
      true
    );

    assert.equal(
      result.intent.status,
      GuestJourneyCoordinationIntentStatus
        .WAITING_FOR_EVIDENCE
    );

    assert.equal(
      result.intent.leaseExpiresAt,
      null
    );

    assert.equal(
      calls.intentUpdateMany[0]
        .where.leaseToken,
      "lease-token-1"
    );

    assert.equal(
      calls.intentUpdateMany[0]
        .data.leaseToken,
      null
    );
  }
);

test(
  "prevents a stale lease token from changing a reclaimed intent",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      initialRecord: {
        status:
          GuestJourneyCoordinationIntentStatus
            .CLAIMED,

        leaseToken:
          "new-lease-token",
      },

      updateCounts: [0],
    });

    const result =
      await markGuestJourneyCoordinationIntentWaitingForEvidence(
        tx,
        {
          intentId:
            "intent-1",

          leaseToken:
            "stale-lease-token",

          now: NOW,
        }
      );

    assert.equal(
      result.transitioned,
      false
    );

    assert.equal(
      result.intent.status,
      GuestJourneyCoordinationIntentStatus
        .CLAIMED
    );

    assert.equal(
      calls.intentUpdateMany[0]
        .where.leaseToken,
      "stale-lease-token"
    );
  }
);

test(
  "marks a claimed intent retryable with its next eligible action time",
  async () => {
    const nextActionAt =
      new Date(
        "2026-08-06T18:05:00.000Z"
      );

    const {
      tx,
      calls,
    } = createMockTransaction({
      initialRecord: {
        status:
          GuestJourneyCoordinationIntentStatus
            .CLAIMED,

        leaseToken:
          "lease-token-1",
      },
    });

    const result =
      await markGuestJourneyCoordinationIntentRetryable(
        tx,
        {
          intentId:
            "intent-1",

          leaseToken:
            "lease-token-1",

          now: NOW,
          nextActionAt,

          lastError:
            "Access provider temporarily unavailable.",
        }
      );

    assert.equal(
      result.transitioned,
      true
    );

    assert.equal(
      result.intent.status,
      GuestJourneyCoordinationIntentStatus
        .RETRYABLE
    );

    assert.equal(
      result.intent
        .nextActionAt
        ?.toISOString(),

      nextActionAt.toISOString()
    );

    assert.equal(
      result.intent.lastError,
      "Access provider temporarily unavailable."
    );

    assert.equal(
      calls.intentUpdateMany[0]
        .data.leaseToken,
      null
    );
  }
);

test(
  "rejects a retry schedule earlier than the current evaluation time",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction();

    await assert.rejects(
      markGuestJourneyCoordinationIntentRetryable(
        tx,
        {
          intentId:
            "intent-1",

          leaseToken:
            "lease-token-1",

          now: NOW,

          nextActionAt:
            new Date(
              "2026-08-06T17:59:59.000Z"
            ),

          lastError:
            "temporary failure",
        }
      ),

      /nextActionAt must not be earlier than now/
    );

    assert.equal(
      calls
        .intentUpdateMany
        .length,
      0
    );
  }
);

test(
  "marks an intent succeeded only from WAITING_FOR_EVIDENCE",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      initialRecord: {
        status:
          GuestJourneyCoordinationIntentStatus
            .WAITING_FOR_EVIDENCE,
      },
    });

    const result =
      await markGuestJourneyCoordinationIntentSucceeded(
        tx,
        {
          intentId:
            "intent-1",

          outcomeEvidenceFingerprint:
            OUTCOME_EVIDENCE_FINGERPRINT,

          now: NOW,
        }
      );

    assert.equal(
      result.transitioned,
      true
    );

    assert.equal(
      result.intent.status,
      GuestJourneyCoordinationIntentStatus
        .SUCCEEDED
    );

    assert.equal(
      result.intent
        .outcomeEvidenceFingerprint,

      OUTCOME_EVIDENCE_FINGERPRINT
    );

    assert.equal(
      result.intent
        .succeededAt
        ?.toISOString(),

      NOW.toISOString()
    );

    assert.equal(
      calls.intentUpdateMany[0]
        .where.status,

      GuestJourneyCoordinationIntentStatus
        .WAITING_FOR_EVIDENCE
    );
  }
);

test(
  "marks a claimed intent exhausted while preserving its final failure evidence",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      initialRecord: {
        status:
          GuestJourneyCoordinationIntentStatus
            .CLAIMED,

        leaseToken:
          "lease-token-1",
      },
    });

    const result =
      await markGuestJourneyCoordinationIntentExhausted(
        tx,
        {
          intentId:
            "intent-1",

          leaseToken:
            "lease-token-1",

          now: NOW,

          lastError:
            "Access recovery budget exhausted.",
        }
      );

    assert.equal(
      result.transitioned,
      true
    );

    assert.equal(
      result.intent.status,
      GuestJourneyCoordinationIntentStatus
        .EXHAUSTED
    );

    assert.equal(
      result.intent
        .exhaustedAt
        ?.toISOString(),

      NOW.toISOString()
    );

    assert.equal(
      result.intent.lastError,
      "Access recovery budget exhausted."
    );

    assert.equal(
      calls.intentUpdateMany[0]
        .where.leaseToken,
      "lease-token-1"
    );
  }
);

test(
  "supersedes only active intents created from obsolete evidence",
  async () => {
    const {
      tx,
      calls,
    } = createMockTransaction({
      updateCounts: [3],
    });

    const count =
      await supersedeObsoleteGuestJourneyCoordinationIntents(
        tx,
        {
          reservationId:
            " reservation-1 ",

          activeEvidenceFingerprint:
            NEW_EVIDENCE_FINGERPRINT,

          now: NOW,
        }
      );

    assert.equal(
      count,
      3
    );

    const updateArgs =
      calls.intentUpdateMany[0];

    assert.equal(
      updateArgs.where
        .reservationId,
      "reservation-1"
    );

    assert.deepEqual(
      updateArgs.where.status.in,
      [
        GuestJourneyCoordinationIntentStatus
          .PENDING,

        GuestJourneyCoordinationIntentStatus
          .CLAIMED,

        GuestJourneyCoordinationIntentStatus
          .WAITING_FOR_EVIDENCE,

        GuestJourneyCoordinationIntentStatus
          .RETRYABLE,
      ]
    );

    assert.equal(
      updateArgs.where
        .evidenceFingerprint.not,

      NEW_EVIDENCE_FINGERPRINT
    );

    assert.equal(
      updateArgs.data.status,

      GuestJourneyCoordinationIntentStatus
        .SUPERSEDED
    );

    assert.equal(
      updateArgs.data
        .supersededAt
        .toISOString(),

      NOW.toISOString()
    );
  }
);