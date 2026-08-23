import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestJourneyCoordinationAttemptOutcome,
  GuestJourneyCoordinationIntentStatus,
} from "@prisma/client";

import {
  claimGuestJourneyAccessEvaluationIntent,
  completeGuestJourneyAccessEvaluationIntent,
  normalizeOwnerRuntimeError,
} from "./guest-journey-owner-runtime.service";
import type {
  ClaimedAccessEvaluationIntent,
} from "./guest-journey-owner-runtime.service";

const NOW = new Date(
  "2026-08-22T12:00:00.000Z"
);

function intent(
  overrides: Record<string, unknown> = {}
) {
  return {
    id: "intent-1",
    intentKey: "intent-key-1",
    reservationId: "reservation-1",
    journeyId: "journey-1",
    intentType:
      "REQUEST_ACCESS_EVALUATION",
    targetEngine: "ACCESS",
    expectedOutcomeCode:
      "ACCESS_RELEASE_STATUS_ELIGIBLE",
    evidenceFingerprint:
      "evidence-before",
    status:
      GuestJourneyCoordinationIntentStatus
        .PENDING,
    claimCount: 0,
    leaseToken: null,
    claimedAt: null,
    leaseExpiresAt: null,
    nextActionAt: NOW,
    reservation: {
      propertyId: "property-1",
      property: {
        organizationId: "org-1",
      },
    },
    ...overrides,
  };
}

function claimInput(
  overrides: Record<string, unknown> = {}
) {
  return {
    intentId: "intent-1",
    leaseToken:
      "secret-lease-token",
    scope: {
      organizationIds: ["org-1"],
      propertyIds: [],
    },
    leaseMs: 120_000,
    maxClaims: 5,
    now: NOW,
    ...overrides,
  };
}

function auditModel() {
  const created: any[] = [];

  return {
    created,
    model: {
      findUnique: async () => null,
      create: async (args: any) => {
        created.push(args);
        return args.data;
      },
    },
  };
}

function claimDb(input: {
  currentIntent: any;
  intentUpdateCount?: number;
  staleAttemptUpdateCount?: number;
}) {
  const calls: Record<
    string,
    any[]
  > = {
    intentUpdates: [],
    attemptUpdates: [],
    attemptCreates: [],
  };
  const audit = auditModel();
  let isolationLevel: unknown;

  return {
    calls,
    audit,
    get isolationLevel() {
      return isolationLevel;
    },
    db: {
      $transaction: async (
        callback: (tx: any) => Promise<any>,
        options: any
      ) => {
        isolationLevel =
          options?.isolationLevel;
        return callback({
          guestJourneyCoordinationIntent: {
            findUnique: async () =>
              input.currentIntent,
            updateMany: async (
              args: any
            ) => {
              calls.intentUpdates.push(
                args
              );
              return {
                count:
                  input.intentUpdateCount ??
                  1,
              };
            },
          },
          guestJourneyCoordinationIntentAttempt:
            {
              updateMany: async (
                args: any
              ) => {
                calls.attemptUpdates.push(
                  args
                );
                return {
                  count:
                    input.staleAttemptUpdateCount ??
                    1,
                };
              },
              create: async (args: any) => {
                calls.attemptCreates.push(
                  args
                );
                return args.data;
              },
            },
          apmsAuditEntry: audit.model,
        });
      },
    },
  };
}

test("claims with serializable CAS and stores only the lease fingerprint in attempt evidence", async () => {
  const harness = claimDb({
    currentIntent: intent(),
  });
  const result =
    await claimGuestJourneyAccessEvaluationIntent(
      harness.db as never,
      claimInput()
    );

  assert.equal(result.claimed, true);
  assert.equal(
    harness.isolationLevel,
    "Serializable"
  );
  assert.equal(
    harness.calls.intentUpdates[0]
      .data.claimCount,
    1
  );
  assert.equal(
    harness.calls.intentUpdates[0]
      .data.leaseToken,
    "secret-lease-token"
  );
  assert.equal(
    harness.calls.attemptCreates[0]
      .data.leaseTokenFingerprint
      .length,
    64
  );
  assert.notEqual(
    harness.calls.attemptCreates[0]
      .data.leaseTokenFingerprint,
    "secret-lease-token"
  );
  assert.equal(
    JSON.stringify(
      harness.audit.created
    ).includes("secret-lease-token"),
    false
  );
});

test("does not steal a live lease", async () => {
  const harness = claimDb({
    currentIntent: intent({
      status:
        GuestJourneyCoordinationIntentStatus
          .CLAIMED,
      claimCount: 1,
      leaseToken: "lease-live",
      claimedAt: NOW,
      leaseExpiresAt: new Date(
        NOW.getTime() + 1
      ),
      nextActionAt: null,
    }),
  });
  const result =
    await claimGuestJourneyAccessEvaluationIntent(
      harness.db as never,
      claimInput()
    );

  assert.deepEqual(result, {
    claimed: false,
    reason: "LIVE_LEASE",
  });
  assert.equal(
    harness.calls.intentUpdates.length,
    0
  );
});

test("recovers an expired lease and closes its prior attempt before reclaiming", async () => {
  const harness = claimDb({
    currentIntent: intent({
      status:
        GuestJourneyCoordinationIntentStatus
          .CLAIMED,
      claimCount: 1,
      leaseToken: "lease-stale",
      claimedAt: new Date(
        NOW.getTime() - 120_000
      ),
      leaseExpiresAt: new Date(
        NOW.getTime() - 1
      ),
      nextActionAt: null,
    }),
  });
  const result =
    await claimGuestJourneyAccessEvaluationIntent(
      harness.db as never,
      claimInput()
    );

  assert.equal(result.claimed, true);
  if (result.claimed) {
    assert.equal(
      result.recoveredStaleLease,
      true
    );
    assert.equal(
      result.claim.attemptNumber,
      2
    );
  }
  assert.equal(
    harness.calls.attemptUpdates[0]
      .data.outcome,
    GuestJourneyCoordinationAttemptOutcome
      .LEASE_EXPIRED
  );
  assert.equal(
    harness.calls.attemptCreates[0]
      .data.attemptNumber,
    2
  );
});

test("fails closed when stale attempt evidence is missing", async () => {
  const harness = claimDb({
    currentIntent: intent({
      status:
        GuestJourneyCoordinationIntentStatus
          .CLAIMED,
      claimCount: 1,
      leaseToken: "lease-stale",
      claimedAt: new Date(
        NOW.getTime() - 120_000
      ),
      leaseExpiresAt: new Date(
        NOW.getTime() - 1
      ),
      nextActionAt: null,
    }),
    staleAttemptUpdateCount: 0,
  });

  await assert.rejects(
    claimGuestJourneyAccessEvaluationIntent(
      harness.db as never,
      claimInput()
    ),
    /STALE_ATTEMPT_EVIDENCE_MISSING/
  );
  assert.equal(
    harness.calls.intentUpdates.length,
    0
  );
});

test("exhausts a stale claim budget without executing another attempt", async () => {
  const harness = claimDb({
    currentIntent: intent({
      status:
        GuestJourneyCoordinationIntentStatus
          .CLAIMED,
      claimCount: 5,
      leaseToken: "lease-stale",
      claimedAt: new Date(
        NOW.getTime() - 120_000
      ),
      leaseExpiresAt: new Date(
        NOW.getTime() - 1
      ),
      nextActionAt: null,
    }),
  });
  const result =
    await claimGuestJourneyAccessEvaluationIntent(
      harness.db as never,
      claimInput()
    );

  assert.deepEqual(result, {
    claimed: false,
    reason: "EXHAUSTED",
  });
  assert.equal(
    harness.calls.intentUpdates[0]
      .data.status,
    GuestJourneyCoordinationIntentStatus
      .EXHAUSTED
  );
  assert.equal(
    harness.calls.attemptCreates.length,
    0
  );
});

test("enforces tenant scope at claim time", async () => {
  const harness = claimDb({
    currentIntent: intent(),
  });

  await assert.rejects(
    claimGuestJourneyAccessEvaluationIntent(
      harness.db as never,
      claimInput({
        scope: {
          organizationIds: [
            "another-org",
          ],
          propertyIds: [],
        },
      })
    ),
    /SCOPE_MISMATCH/
  );
});

test("returns a race without creating attempt evidence when CAS loses", async () => {
  const harness = claimDb({
    currentIntent: intent(),
    intentUpdateCount: 0,
  });
  const result =
    await claimGuestJourneyAccessEvaluationIntent(
      harness.db as never,
      claimInput()
    );

  assert.deepEqual(result, {
    claimed: false,
    reason: "CLAIM_RACE",
  });
  assert.equal(
    harness.calls.attemptCreates.length,
    0
  );
});

function claimedIntent(
  overrides: Record<string, unknown> = {}
) {
  return intent({
    status:
      GuestJourneyCoordinationIntentStatus
        .CLAIMED,
    claimCount: 1,
    leaseToken: "lease-1",
    claimedAt: NOW,
    leaseExpiresAt: new Date(
      NOW.getTime() + 120_000
    ),
    ...overrides,
  });
}

function claimRecord(
  overrides: Partial<
    ClaimedAccessEvaluationIntent
  > = {}
): ClaimedAccessEvaluationIntent {
  return {
    intentId: "intent-1",
    intentKey: "intent-key-1",
    reservationId: "reservation-1",
    journeyId: "journey-1",
    organizationId: "org-1",
    propertyId: "property-1",
    targetEngine: "ACCESS",
    intentType:
      "REQUEST_ACCESS_EVALUATION",
    expectedOutcomeCode:
      "ACCESS_RELEASE_STATUS_ELIGIBLE",
    inputEvidenceFingerprint:
      "evidence-before",
    attemptNumber: 1,
    leaseToken: "lease-1",
    leaseExpiresAt: new Date(
      NOW.getTime() + 120_000
    ),
    ...overrides,
  };
}

function completionDb(input: {
  currentIntent?: any;
  attempt?: any;
  intentUpdateCount?: number;
  attemptUpdateCount?: number;
}) {
  const currentIntent =
    input.currentIntent ??
    claimedIntent();
  const attempt =
    input.attempt ?? {
      id: "attempt-1",
      outcome:
        GuestJourneyCoordinationAttemptOutcome
          .IN_FLIGHT,
      startedAt: NOW,
      leaseExpiresAt:
        currentIntent.leaseExpiresAt,
      leaseTokenFingerprint:
        "62347e78440f09d723a76daa7b7f9302d5308d46dea28d67628bee7247a42812",
      inputEvidenceFingerprint:
        "evidence-before",
    };
  const intentUpdates: any[] = [];
  const attemptUpdates: any[] = [];
  const audit = auditModel();

  return {
    intentUpdates,
    attemptUpdates,
    db: {
      $transaction: async (
        callback: (tx: any) => Promise<any>
      ) => callback({
        guestJourneyCoordinationIntent: {
          findUnique: async () =>
            currentIntent,
          updateMany: async (
            args: any
          ) => {
            intentUpdates.push(args);
            return {
              count:
                input.intentUpdateCount ??
                1,
            };
          },
        },
        guestJourneyCoordinationIntentAttempt:
          {
            findUnique: async () =>
              attempt,
            updateMany: async (
              args: any
            ) => {
              attemptUpdates.push(args);
              return {
                count:
                  input.attemptUpdateCount ??
                  1,
              };
            },
          },
        apmsAuditEntry: audit.model,
      }),
    },
  };
}

test("completes success only through the active fenced attempt", async () => {
  const harness = completionDb({});
  const result =
    await completeGuestJourneyAccessEvaluationIntent(
      harness.db as never,
      {
        claim: claimRecord(),
        completion: {
          kind: "SUCCEEDED",
          outcomeEvidenceFingerprint:
            "evidence-after",
        },
        maxClaims: 5,
        retryBaseMs: 60_000,
        now: new Date(
          NOW.getTime() + 1_000
        ),
      }
    );

  assert.equal(result.status, "SUCCEEDED");
  assert.equal(
    harness.intentUpdates[0]
      .where.leaseToken,
    "lease-1"
  );
  assert.equal(
    harness.intentUpdates[0]
      .data.outcomeEvidenceFingerprint,
    "evidence-after"
  );
  assert.equal(
    harness.attemptUpdates[0]
      .data.outcome,
    GuestJourneyCoordinationAttemptOutcome
      .SUCCEEDED
  );
});

test("rejects a stolen lease token and performs no completion writes", async () => {
  const harness = completionDb({});

  await assert.rejects(
    completeGuestJourneyAccessEvaluationIntent(
      harness.db as never,
      {
        claim: claimRecord({
          leaseToken:
            "stolen-token",
        }),
        completion: {
          kind: "SUCCEEDED",
          outcomeEvidenceFingerprint:
            "evidence-after",
        },
        maxClaims: 5,
        retryBaseMs: 60_000,
        now: new Date(
          NOW.getTime() + 1_000
        ),
      }
    ),
    /LEASE_MISMATCH/
  );
  assert.equal(
    harness.intentUpdates.length,
    0
  );
});

test("rejects completion at the exact lease boundary", async () => {
  const harness = completionDb({});

  await assert.rejects(
    completeGuestJourneyAccessEvaluationIntent(
      harness.db as never,
      {
        claim: claimRecord(),
        completion: {
          kind: "SUCCEEDED",
          outcomeEvidenceFingerprint:
            "evidence-after",
        },
        maxClaims: 5,
        retryBaseMs: 60_000,
        now: new Date(
          NOW.getTime() + 120_000
        ),
      }
    ),
    /COMPLETION_LEASE_EXPIRED/
  );
});

test("places retryable failures on deterministic exponential backoff", async () => {
  const harness = completionDb({});
  const completedAt = new Date(
    NOW.getTime() + 1_000
  );
  const result =
    await completeGuestJourneyAccessEvaluationIntent(
      harness.db as never,
      {
        claim: claimRecord(),
        completion: {
          kind: "RETRYABLE",
          errorCode: "DATABASE_BUSY",
          errorDetail: "retry safely",
        },
        maxClaims: 5,
        retryBaseMs: 60_000,
        now: completedAt,
      }
    );

  assert.equal(result.status, "RETRYABLE");
  assert.equal(
    result.nextActionAt?.toISOString(),
    new Date(
      completedAt.getTime() + 60_000
    ).toISOString()
  );
});

test("exhausts instead of scheduling another retry at the claim budget", async () => {
  const currentIntent =
    claimedIntent({ claimCount: 5 });
  const harness = completionDb({
    currentIntent,
    attempt: {
      id: "attempt-5",
      outcome:
        GuestJourneyCoordinationAttemptOutcome
          .IN_FLIGHT,
      startedAt: NOW,
      leaseExpiresAt:
        currentIntent.leaseExpiresAt,
      leaseTokenFingerprint:
        "62347e78440f09d723a76daa7b7f9302d5308d46dea28d67628bee7247a42812",
      inputEvidenceFingerprint:
        "evidence-before",
    },
  });
  const result =
    await completeGuestJourneyAccessEvaluationIntent(
      harness.db as never,
      {
        claim: claimRecord({
          attemptNumber: 5,
        }),
        completion: {
          kind: "RETRYABLE",
          errorCode: "DATABASE_BUSY",
          errorDetail: "still busy",
        },
        maxClaims: 5,
        retryBaseMs: 60_000,
        now: new Date(
          NOW.getTime() + 1_000
        ),
      }
    );

  assert.equal(result.status, "EXHAUSTED");
  assert.equal(result.nextActionAt, null);
  assert.equal(
    harness.attemptUpdates[0]
      .data.outcome,
    GuestJourneyCoordinationAttemptOutcome
      .EXHAUSTED
  );
});

test("keeps business blockers waiting without consuming a retry schedule", async () => {
  const harness = completionDb({});
  const result =
    await completeGuestJourneyAccessEvaluationIntent(
      harness.db as never,
      {
        claim: claimRecord(),
        completion: {
          kind:
            "WAITING_FOR_EVIDENCE",
          outcomeEvidenceFingerprint:
            "evidence-blocked",
          errorCode:
            "ACCESS_EVIDENCE_PENDING",
          errorDetail:
            "PAYMENT_NOT_PAID",
        },
        maxClaims: 5,
        retryBaseMs: 60_000,
        now: new Date(
          NOW.getTime() + 1_000
        ),
      }
    );

  assert.equal(
    result.status,
    "WAITING_FOR_EVIDENCE"
  );
  assert.equal(result.nextActionAt, null);
});

test("normalizes structured and unstructured runtime errors", () => {
  assert.equal(
    normalizeOwnerRuntimeError({
      code: "DB_TIMEOUT",
    }).code,
    "DB_TIMEOUT"
  );
  assert.equal(
    normalizeOwnerRuntimeError(
      new Error("access failed: detail")
    ).code,
    "ACCESS_FAILED"
  );
  assert.doesNotMatch(
    normalizeOwnerRuntimeError(
      new Error(
        "Bearer private-token password=unsafe postgres://user:pass@db/internal"
      )
    ).detail,
    /private-token|unsafe|user:pass/
  );
});
