import assert from "node:assert/strict";
import test from "node:test";

import type { GuestJourneyFinancialOwnerConfig } from "./guest-journey-financial-owner.config";
import { runGuestJourneyFinancialOwnerCycle } from "./guest-journey-financial-owner-cycle.service";

const now = new Date("2026-08-24T12:00:00.000Z");

function config(enabled: boolean): GuestJourneyFinancialOwnerConfig {
  return {
    enabled,
    batchSize: 10,
    leaseMs: 60_000,
    maxClaims: 3,
    retryBaseMs: 60_000,
    organizationIds: enabled ? ["org-1"] : [],
    propertyIds: [],
  };
}

function prismaWithCandidates(candidates: any[]) {
  const queries: any[] = [];
  return {
    prisma: {
      guestJourneyCoordinationIntent: {
        findMany: async (query: any) => {
          queries.push(query);
          return candidates;
        },
      },
    } as any,
    queries,
  };
}

const candidate = {
  id: "intent-1",
  reservation: {
    propertyId: "property-1",
    property: { organizationId: "org-1" },
  },
};

const claimed = {
  claimed: true as const,
  recoveredStaleLease: false,
  claim: {
    intentId: "intent-1",
    intentKey: "key-1",
    reservationId: "reservation-1",
    journeyId: "journey-1",
    organizationId: "org-1",
    propertyId: "property-1",
    targetEngine: "FINANCIAL" as const,
    intentType: "REQUEST_PAYMENT_EVALUATION" as const,
    expectedOutcomeCode: "PAYMENT_STATE_RESOLVED" as const,
    inputEvidenceFingerprint: "input",
    attemptNumber: 1,
    leaseToken: "lease-1",
    leaseExpiresAt: new Date(now.getTime() + 60_000),
  },
};

test("E9 disabled performs no selection, claim, evaluation or Mission Control work", async () => {
  const state = prismaWithCandidates([candidate]);
  let calls = 0;
  const metrics = await runGuestJourneyFinancialOwnerCycle(
    state.prisma,
    config(false),
    {
      now,
      dependencies: {
        claim: async () => { calls += 1; return claimed; },
        execute: async () => { calls += 1; throw new Error("not expected"); },
        complete: async () => { calls += 1; throw new Error("not expected"); },
        syncMissionControl: async () => { calls += 1; throw new Error("not expected"); },
      } as any,
    }
  );
  assert.equal(metrics.enabled, false);
  assert.equal(metrics.selected, 0);
  assert.equal(state.queries.length, 0);
  assert.equal(calls, 0);
});

test("E9 selects only scoped due FINANCIAL payment evaluation intents", async () => {
  const state = prismaWithCandidates([]);
  await runGuestJourneyFinancialOwnerCycle(state.prisma, config(true), { now });
  assert.equal(state.queries.length, 1);
  const queryText = JSON.stringify(state.queries[0]);
  assert.match(queryText, /FINANCIAL/);
  assert.match(queryText, /REQUEST_PAYMENT_EVALUATION/);
  assert.doesNotMatch(queryText, /REQUEST_ACCESS|REQUEST_COMMUNICATION|REQUEST_GUEST_VERIFICATION/);
  assert.match(queryText, /org-1/);
  assert.equal(state.queries[0].take, 10);
});

test("E9 claims, evaluates, completes and projects one payment intent with zero provider calls", async () => {
  const state = prismaWithCandidates([candidate]);
  const calls: string[] = [];
  const metrics = await runGuestJourneyFinancialOwnerCycle(
    state.prisma,
    config(true),
    {
      now,
      dependencies: {
        leaseTokenFactory: () => "lease-1",
        clock: () => now,
        claim: async () => { calls.push("claim"); return claimed; },
        execute: async () => {
          calls.push("execute");
          return {
            providerCalls: 0 as const,
            completion: {
              kind: "SUCCEEDED" as const,
              action: "PAYMENT_ALREADY_SATISFIED" as const,
              paymentState: "PAID" as any,
              outcomeEvidenceFingerprint: "output",
            },
          };
        },
        complete: async () => {
          calls.push("complete");
          return {
            intentId: "intent-1",
            attemptNumber: 1,
            status: "SUCCEEDED" as const,
            nextActionAt: null,
          };
        },
        syncMissionControl: async () => {
          calls.push("mission-control");
          return {
            action: "NOT_REQUIRED" as const,
            operationalIssueWrites: 0,
            externalSideEffects: 0 as const,
          };
        },
      },
    }
  );
  assert.deepEqual(calls, ["claim", "execute", "complete", "mission-control"]);
  assert.equal(metrics.claimed, 1);
  assert.equal(metrics.providerCalls, 0);
  assert.equal(metrics.succeeded, 1);
  assert.equal(metrics.errors, 0);
});

test("E9 projects exhausted claim budgets without evaluation replay", async () => {
  const state = prismaWithCandidates([candidate]);
  let evaluations = 0;
  let projections = 0;
  const metrics = await runGuestJourneyFinancialOwnerCycle(
    state.prisma,
    config(true),
    {
      now,
      dependencies: {
        claim: async () => ({ claimed: false as const, reason: "EXHAUSTED" as const }),
        execute: async () => { evaluations += 1; throw new Error("not expected"); },
        syncMissionControl: async () => {
          projections += 1;
          return {
            action: "CREATED" as const,
            operationalIssueWrites: 1,
            externalSideEffects: 0 as const,
          };
        },
      } as any,
    }
  );
  assert.equal(evaluations, 0);
  assert.equal(projections, 1);
  assert.equal(metrics.exhausted, 1);
  assert.equal(metrics.operationalIssueWrites, 1);
});

test("E9 isolates one intent failure and reports a stable redacted error code", async () => {
  const state = prismaWithCandidates([candidate, { ...candidate, id: "intent-2" }]);
  let claims = 0;
  const metrics = await runGuestJourneyFinancialOwnerCycle(
    state.prisma,
    config(true),
    {
      now,
      dependencies: {
        claim: async () => {
          claims += 1;
          throw new Error("FINANCIAL_TEST_FAILURE token=secret");
        },
      } as any,
    }
  );
  assert.equal(claims, 2);
  assert.equal(metrics.errors, 2);
  assert.equal(metrics.errorCodeCounts.FINANCIAL_TEST_FAILURE_TOKEN_REDACTED, 2);
});
