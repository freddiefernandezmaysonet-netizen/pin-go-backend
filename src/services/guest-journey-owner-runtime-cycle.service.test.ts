import assert from "node:assert/strict";
import test from "node:test";

import {
  runGuestJourneyOwnerRuntimeCycle,
} from "./guest-journey-owner-runtime-cycle.service";
import type {
  GuestJourneyOwnerRuntimeConfig,
} from "./guest-journey-owner-runtime.config";
import type {
  ClaimedAccessEvaluationIntent,
} from "./guest-journey-owner-runtime.service";

const NOW = new Date(
  "2026-08-22T12:00:00.000Z"
);

function config(
  overrides: Partial<
    GuestJourneyOwnerRuntimeConfig
  > = {}
): GuestJourneyOwnerRuntimeConfig {
  return {
    enabled: true,
    batchSize: 10,
    leaseMs: 120_000,
    maxClaims: 5,
    retryBaseMs: 60_000,
    organizationIds: ["org-1"],
    propertyIds: [],
    ...overrides,
  };
}

function claim():
  ClaimedAccessEvaluationIntent {
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
  };
}

function prismaCandidates(
  candidates: Array<{ id: string }>
) {
  const queries: any[] = [];

  return {
    queries,
    prisma: {
      guestJourneyCoordinationIntent: {
        findMany: async (query: any) => {
          queries.push(query);
          return candidates;
        },
      },
    },
  };
}

test("does no reads or owner execution while E5 is disabled", async () => {
  let read = false;
  const metrics =
    await runGuestJourneyOwnerRuntimeCycle(
      {
        guestJourneyCoordinationIntent: {
          findMany: async () => {
            read = true;
            return [];
          },
        },
      } as never,
      config({
        enabled: false,
        organizationIds: [],
      }),
      { now: NOW }
    );

  assert.equal(read, false);
  assert.equal(metrics.enabled, false);
  assert.equal(metrics.executed, 0);
  assert.equal(
    metrics.externalSideEffects,
    0
  );
});

test("selects only due ACCESS evaluation intents inside the canary scope", async () => {
  const harness = prismaCandidates([]);

  await runGuestJourneyOwnerRuntimeCycle(
    harness.prisma as never,
    config({
      propertyIds: ["property-1"],
    }),
    { now: NOW }
  );

  const query = harness.queries[0];
  assert.equal(
    query.where.targetEngine,
    "ACCESS"
  );
  assert.equal(
    query.where.intentType,
    "REQUEST_ACCESS_EVALUATION"
  );
  assert.equal(query.take, 10);
  assert.equal(
    JSON.stringify(query).includes(
      "REQUEST_ACCESS_PROVISIONING"
    ),
    false
  );
  assert.equal(
    JSON.stringify(query).includes(
      "COMMUNICATIONS"
    ),
    false
  );
});

test("claims, executes and completes one registered handler", async () => {
  const harness = prismaCandidates([
    { id: "intent-1" },
  ]);
  const calls: string[] = [];
  const metrics =
    await runGuestJourneyOwnerRuntimeCycle(
      harness.prisma as never,
      config(),
      {
        now: NOW,
        dependencies: {
          leaseTokenFactory: () =>
            "lease-1",
          clock: () =>
            new Date(
              NOW.getTime() + 1_000
            ),
          claim: async (_db, input) => {
            calls.push(
              `claim:${input.intentId}:${input.leaseToken}`
            );
            return {
              claimed: true,
              recoveredStaleLease:
                false,
              claim: claim(),
            };
          },
          execute: async () => {
            calls.push("execute");
            return {
              handlerCode:
                "ACCESS_EVALUATION_V1",
              externalSideEffects:
                0,
              completion: {
                kind:
                  "SUCCEEDED",
                outcomeEvidenceFingerprint:
                  "evidence-after",
              },
            };
          },
          complete: async (
            _db,
            input
          ) => {
            calls.push(
              `complete:${input.completion.kind}`
            );
            return {
              intentId: "intent-1",
              attemptNumber: 1,
              status:
                "SUCCEEDED",
              nextActionAt: null,
            };
          },
        },
      }
    );

  assert.deepEqual(calls, [
    "claim:intent-1:lease-1",
    "execute",
    "complete:SUCCEEDED",
  ]);
  assert.equal(metrics.claimed, 1);
  assert.equal(metrics.executed, 1);
  assert.equal(metrics.succeeded, 1);
  assert.equal(metrics.errors, 0);
});

test("converts handler crashes into fenced retryable completion", async () => {
  const harness = prismaCandidates([
    { id: "intent-1" },
  ]);
  let completion: any;
  const metrics =
    await runGuestJourneyOwnerRuntimeCycle(
      harness.prisma as never,
      config(),
      {
        now: NOW,
        dependencies: {
          clock: () =>
            new Date(
              NOW.getTime() + 1_000
            ),
          claim: async () => ({
            claimed: true,
            recoveredStaleLease: false,
            claim: claim(),
          }),
          execute: async () => {
            throw new Error(
              "DATABASE_UNAVAILABLE: temporary"
            );
          },
          complete: async (
            _db,
            input
          ) => {
            completion =
              input.completion;
            return {
              intentId: "intent-1",
              attemptNumber: 1,
              status:
                "RETRYABLE",
              nextActionAt:
                new Date(),
            };
          },
        },
      }
    );

  assert.equal(
    completion.kind,
    "RETRYABLE"
  );
  assert.equal(
    completion.errorCode,
    "DATABASE_UNAVAILABLE"
  );
  assert.equal(metrics.executed, 0);
  assert.equal(metrics.retryable, 1);
});

test("records stale recovery, races and exhaustion without executing unclaimed work", async () => {
  const harness = prismaCandidates([
    { id: "intent-1" },
    { id: "intent-2" },
    { id: "intent-3" },
  ]);
  let claims = 0;
  let executions = 0;
  const metrics =
    await runGuestJourneyOwnerRuntimeCycle(
      harness.prisma as never,
      config(),
      {
        now: NOW,
        dependencies: {
          claim: async () => {
            claims += 1;
            if (claims === 1) {
              return {
                claimed: true,
                recoveredStaleLease:
                  true,
                claim: claim(),
              };
            }
            return claims === 2
              ? {
                  claimed: false,
                  reason:
                    "CLAIM_RACE",
                }
              : {
                  claimed: false,
                  reason:
                    "EXHAUSTED",
                };
          },
          execute: async () => {
            executions += 1;
            return {
              handlerCode:
                "ACCESS_EVALUATION_V1",
              externalSideEffects:
                0,
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
            };
          },
          complete: async () => ({
            intentId: "intent-1",
            attemptNumber: 1,
            status:
              "WAITING_FOR_EVIDENCE",
            nextActionAt: null,
          }),
        },
      }
    );

  assert.equal(executions, 1);
  assert.equal(
    metrics.recoveredStaleLeases,
    1
  );
  assert.equal(metrics.claimRaces, 1);
  assert.equal(metrics.exhausted, 1);
  assert.equal(
    metrics.waitingForEvidence,
    1
  );
});

test("fails closed if enabled without tenant scope", async () => {
  await assert.rejects(
    runGuestJourneyOwnerRuntimeCycle(
      {} as never,
      config({
        organizationIds: [],
        propertyIds: [],
      }),
      { now: NOW }
    ),
    /OWNER_RUNTIME_SCOPE_REQUIRED/
  );
});
