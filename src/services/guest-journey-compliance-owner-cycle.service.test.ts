import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import { runGuestJourneyComplianceOwnerCycle } from "./guest-journey-compliance-owner-cycle.service";
import type { GuestJourneyComplianceOwnerConfig } from "./guest-journey-compliance-owner.config";

function config(enabled: boolean): GuestJourneyComplianceOwnerConfig {
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
  let query: any = null;
  const prisma = {
    guestJourneyCoordinationIntent: {
      findMany: async (input: any) => {
        query = input;
        return candidates;
      },
    },
  } as unknown as PrismaClient;
  return { prisma, get query() { return query; } };
}

function candidate() {
  return {
    id: "intent-1",
    reservation: {
      propertyId: "property-1",
      property: { organizationId: "org-1" },
    },
  };
}

test("E10 Compliance cycle is no-op when disabled", async () => {
  const state = prismaWithCandidates([candidate()]);
  const metrics = await runGuestJourneyComplianceOwnerCycle(
    state.prisma,
    config(false),
    { now: new Date("2026-08-24T13:00:00.000Z") }
  );

  assert.equal(metrics.enabled, false);
  assert.equal(metrics.selected, 0);
  assert.equal(metrics.executed, 0);
});

test("E10 Compliance cycle selects only COMPLIANCE requirement and verification intents", async () => {
  const state = prismaWithCandidates([]);
  await runGuestJourneyComplianceOwnerCycle(
    state.prisma,
    config(true),
    { now: new Date("2026-08-24T13:00:00.000Z") }
  );

  const queryText = JSON.stringify(state.query);
  assert.match(queryText, /COMPLIANCE/);
  assert.match(queryText, /REQUEST_REQUIREMENTS_SNAPSHOT/);
  assert.match(queryText, /REQUEST_GUEST_VERIFICATION/);
  assert.doesNotMatch(queryText, /REQUEST_ACCESS/);
  assert.doesNotMatch(queryText, /REQUEST_PAYMENT_EVALUATION/);
  assert.doesNotMatch(queryText, /REQUEST_COMMUNICATION/);
});

test("E10 Compliance cycle executes claimed intent and projects Mission Control", async () => {
  const state = prismaWithCandidates([candidate()]);
  const now = new Date("2026-08-24T13:00:00.000Z");
  const metrics = await runGuestJourneyComplianceOwnerCycle(
    state.prisma,
    config(true),
    {
      now,
      dependencies: {
        leaseTokenFactory: () => "lease-token",
        claim: async () => ({
          claimed: true,
          recoveredStaleLease: false,
          claim: {
            intentId: "intent-1",
            intentKey: "intent-key",
            reservationId: "reservation-1",
            journeyId: "journey-1",
            organizationId: "org-1",
            propertyId: "property-1",
            targetEngine: "COMPLIANCE",
            intentType: "REQUEST_GUEST_VERIFICATION",
            expectedOutcomeCode: "GUEST_VERIFICATION_REQUIREMENTS_SATISFIED",
            inputEvidenceFingerprint: "input",
            attemptNumber: 1,
            leaseToken: "lease-token",
            leaseExpiresAt: new Date("2026-08-24T13:01:00.000Z"),
          },
        }),
        execute: async () => ({
          providerCalls: 0,
          externalSideEffects: 0,
          internalMutations: 1,
          completion: {
            kind: "SUCCEEDED",
            action: "IDENTITY_NOT_REQUIRED_MARKED_COMPLETE",
            verificationStatus: "NOT_REQUIRED",
            outcomeEvidenceFingerprint: "output",
          },
        }),
        complete: async () => ({
          intentId: "intent-1",
          attemptNumber: 1,
          status: "SUCCEEDED",
          nextActionAt: null,
        }),
        syncMissionControl: async () => ({
          action: "NOT_REQUIRED",
          operationalIssueWrites: 0,
          externalSideEffects: 0,
        }),
        clock: () => now,
      },
    }
  );

  assert.equal(metrics.claimed, 1);
  assert.equal(metrics.executed, 1);
  assert.equal(metrics.succeeded, 1);
  assert.equal(metrics.providerCalls, 0);
  assert.equal(metrics.externalSideEffects, 0);
  assert.equal(metrics.internalMutations, 1);
});
