import assert from "node:assert/strict";
import test from "node:test";

import type { GuestJourneyAccessOwnerConfig } from "./guest-journey-access-owner.config";
import { runGuestJourneyAccessOwnerCycle } from "./guest-journey-access-owner-cycle.service";

const now = new Date("2026-08-23T14:00:00.000Z");

function config(enabled: boolean): GuestJourneyAccessOwnerConfig {
  return {
    enabled,
    batchSize: 10,
    leaseMs: 60_000,
    maxClaims: 7,
    retryBaseMs: 60_000,
    providerTimeoutMs: 30_000,
    provisionLeadMs: 2 * 60 * 60_000,
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
    targetEngine: "ACCESS" as const,
    intentType: "REQUEST_ACCESS_PROVISIONING" as const,
    expectedOutcomeCode: "SECURE_GUEST_ACCESS_ACTIVE" as const,
    inputEvidenceFingerprint: "input",
    attemptNumber: 1,
    leaseToken: "lease-1",
    leaseExpiresAt: new Date(now.getTime() + 60_000),
  },
};

test("E8 disabled performs no selection, claim, provider, or Mission Control work", async () => {
  const state = prismaWithCandidates([candidate]);
  let calls = 0;
  const metrics = await runGuestJourneyAccessOwnerCycle(
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

test("E8 selects only bounded scoped due ACCESS execution intents", async () => {
  const state = prismaWithCandidates([]);
  await runGuestJourneyAccessOwnerCycle(state.prisma, config(true), { now });
  assert.equal(state.queries.length, 1);
  const queryText = JSON.stringify(state.queries[0]);
  assert.match(queryText, /REQUEST_ACCESS_PROVISIONING/);
  assert.match(queryText, /REQUEST_ACCESS_REVOCATION_CHECK/);
  assert.doesNotMatch(queryText, /REQUEST_ACCESS_EVALUATION/);
  assert.match(queryText, /org-1/);
  assert.equal(state.queries[0].take, 10);
});

test("E8 claims, executes, completes, and projects one certified access intent", async () => {
  const state = prismaWithCandidates([candidate]);
  const calls: string[] = [];
  const metrics = await runGuestJourneyAccessOwnerCycle(
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
            providerCalls: 1,
            completion: {
              kind: "SUCCEEDED" as const,
              action: "PROVISIONED" as const,
              outcomeEvidenceFingerprint: "output",
              accessGrantIds: ["grant-1"],
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
  assert.equal(metrics.providerCalls, 1);
  assert.equal(metrics.succeeded, 1);
  assert.equal(metrics.errors, 0);
});

test("E8 projects exhausted claim budgets without provider execution", async () => {
  const state = prismaWithCandidates([candidate]);
  let providerCalls = 0;
  let projections = 0;
  const metrics = await runGuestJourneyAccessOwnerCycle(
    state.prisma,
    config(true),
    {
      now,
      dependencies: {
        claim: async () => ({ claimed: false as const, reason: "EXHAUSTED" as const }),
        execute: async () => { providerCalls += 1; throw new Error("not expected"); },
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
  assert.equal(providerCalls, 0);
  assert.equal(projections, 1);
  assert.equal(metrics.exhausted, 1);
  assert.equal(metrics.operationalIssueWrites, 1);
});

test("E8 isolates one intent failure and reports a stable error code", async () => {
  const state = prismaWithCandidates([candidate, { ...candidate, id: "intent-2" }]);
  let claims = 0;
  const metrics = await runGuestJourneyAccessOwnerCycle(
    state.prisma,
    config(true),
    {
      now,
      dependencies: {
        claim: async () => {
          claims += 1;
          throw new Error("ACCESS_TEST_FAILURE: detail");
        },
      } as any,
    }
  );
  assert.equal(claims, 2);
  assert.equal(metrics.errors, 2);
  assert.equal(metrics.errorCodeCounts.ACCESS_TEST_FAILURE, 2);
});
