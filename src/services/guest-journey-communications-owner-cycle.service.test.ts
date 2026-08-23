import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import { runGuestJourneyCommunicationsOwnerCycle } from "./guest-journey-communications-owner-cycle.service";
import type { GuestJourneyCommunicationsOwnerConfig } from "./guest-journey-communications-owner.config";

const config: GuestJourneyCommunicationsOwnerConfig = {
  enabled: true,
  batchSize: 20,
  leaseMs: 60_000,
  maxClaims: 3,
  retryBaseMs: 30_000,
  providerTimeoutMs: 15_000,
  organizationIds: ["org-1"],
  propertyIds: [],
};

const now = new Date("2026-08-23T06:00:00.000Z");

function candidatePrisma(onQuery?: (args: any) => void): PrismaClient {
  return {
    guestJourneyCoordinationIntent: {
      findMany: async (args: any) => {
        onQuery?.(args);
        return [{
          id: "intent-1",
          reservation: {
            propertyId: "property-1",
            property: { organizationId: "org-1" },
          },
        }];
      },
    },
  } as unknown as PrismaClient;
}

const claimed: any = {
  claimed: true,
  recoveredStaleLease: false,
  claim: {
    intentId: "intent-1",
    intentKey: "key-1",
    reservationId: "reservation-1",
    journeyId: "journey-1",
    organizationId: "org-1",
    propertyId: "property-1",
    targetEngine: "COMMUNICATIONS",
    intentType: "REQUEST_COMMUNICATION_RETRY",
    expectedOutcomeCode: "COMMUNICATION_DELIVERY_FINAL",
    payload: {
      messageLogId: "message-1",
      communicationType: "PRECHECKIN",
      channel: "sms",
    },
    inputEvidenceFingerprint: "input",
    attemptNumber: 1,
    leaseToken: "lease-1",
    leaseExpiresAt: new Date(now.getTime() + 60_000),
  },
};

test("disabled E7 performs no selection, claim, provider, or Mission Control work", async () => {
  const prisma = new Proxy({}, {
    get() { throw new Error("database must not execute"); },
  }) as PrismaClient;
  const metrics = await runGuestJourneyCommunicationsOwnerCycle(
    prisma,
    { ...config, enabled: false, organizationIds: [], propertyIds: [] },
    { now }
  );
  assert.equal(metrics.enabled, false);
  assert.equal(metrics.selected, 0);
  assert.equal(metrics.providerCalls, 0);
  assert.equal(metrics.operationalIssueWrites, 0);
});

test("E7 selects only scoped COMMUNICATIONS intents and completes one certified delivery", async () => {
  let query: any;
  const calls: string[] = [];
  const metrics = await runGuestJourneyCommunicationsOwnerCycle(
    candidatePrisma((args) => { query = args; }),
    config,
    {
      now,
      dependencies: {
        clock: () => now,
        leaseTokenFactory: () => "lease-1",
        claim: async () => { calls.push("claim"); return claimed; },
        execute: async () => {
          calls.push("execute");
          return {
            providerCalls: 1,
            completion: {
              kind: "SUCCEEDED",
              outcomeEvidenceFingerprint: "output",
              messageLogId: "message-1",
              communicationType: "PRECHECKIN",
              channel: "sms",
              deliveryStatus: "SENT",
            },
          } as any;
        },
        complete: async () => {
          calls.push("complete");
          return { intentId: "intent-1", attemptNumber: 1, status: "SUCCEEDED", nextActionAt: null };
        },
        syncMissionControl: async () => {
          calls.push("mission-control");
          return { action: "NOT_REQUIRED", operationalIssueWrites: 0, externalSideEffects: 0 };
        },
      },
    }
  );
  assert.equal(query.where.targetEngine, "COMMUNICATIONS");
  assert.deepEqual(query.where.intentType.in, ["REQUEST_COMMUNICATION", "REQUEST_COMMUNICATION_RETRY"]);
  assert.deepEqual(calls, ["claim", "execute", "complete", "mission-control"]);
  assert.equal(metrics.succeeded, 1);
  assert.equal(metrics.providerCalls, 1);
  assert.equal(metrics.errors, 0);
});

test("provider errors become durable retry completions instead of escaping the cycle", async () => {
  let completion: any;
  const metrics = await runGuestJourneyCommunicationsOwnerCycle(
    candidatePrisma(),
    config,
    {
      now,
      dependencies: {
        clock: () => now,
        claim: async () => claimed,
        execute: async () => { throw new Error("TWILIO_TEMPORARY: unavailable"); },
        complete: async (_db, input) => {
          completion = input.completion;
          return { intentId: "intent-1", attemptNumber: 1, status: "RETRYABLE", nextActionAt: new Date(now.getTime() + 30_000) };
        },
        syncMissionControl: async () => ({ action: "NOT_REQUIRED", operationalIssueWrites: 0, externalSideEffects: 0 }),
      },
    }
  );
  assert.equal(completion.kind, "RETRYABLE");
  assert.equal(completion.errorCode, "TWILIO_TEMPORARY");
  assert.equal(metrics.retryable, 1);
  assert.equal(metrics.errors, 0);
});

test("claim-budget exhaustion is projected to Mission Control without provider execution", async () => {
  let executeCalls = 0;
  const metrics = await runGuestJourneyCommunicationsOwnerCycle(
    candidatePrisma(),
    config,
    {
      now,
      dependencies: {
        claim: async () => ({ claimed: false, reason: "EXHAUSTED" }),
        execute: async () => { executeCalls += 1; throw new Error("must not execute"); },
        syncMissionControl: async () => ({ action: "CREATED", operationalIssueWrites: 1, externalSideEffects: 0 }),
      },
    }
  );
  assert.equal(executeCalls, 0);
  assert.equal(metrics.exhausted, 1);
  assert.equal(metrics.operationalIssueWrites, 1);
});
