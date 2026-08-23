import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestAccessMode,
  GuestAccessReleaseStatus,
} from "@prisma/client";

import {
  executeGuestJourneyAccessEvaluationHandler,
} from "./guest-journey-access-evaluation-handler.service";
import type {
  ClaimedAccessEvaluationIntent,
} from "./guest-journey-owner-runtime.service";

const NOW = new Date(
  "2026-08-22T12:00:00.000Z"
);

function claim(
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

function readiness(
  ready: boolean
) {
  return {
    ready,
    reservationId: "reservation-1",
    reservationNumber: "PG-1",
    propertyId: "property-1",
    guestAccessMode:
      GuestAccessMode.PASSCODE_ONLY,
    releaseStatus: ready
      ? GuestAccessReleaseStatus.ELIGIBLE
      : GuestAccessReleaseStatus.BLOCKED,
    checkIn: new Date(
      "2026-08-23T20:00:00.000Z"
    ),
    checkOut: new Date(
      "2026-08-25T15:00:00.000Z"
    ),
    blockers: ready
      ? []
      : ["PAYMENT_NOT_PAID" as const],
  };
}

test("persists ACCESS evaluation then requires canonical outcome evidence before success", async () => {
  const calls: unknown[] = [];
  const result =
    await executeGuestJourneyAccessEvaluationHandler(
      {} as never,
      claim(),
      { now: NOW },
      {
        evaluateReadiness:
          async (...args: any[]) => {
            calls.push([
              "readiness",
              ...args,
            ]);
            return readiness(true);
          },
        loadEvidence:
          async (...args: any[]) => {
            calls.push([
              "evidence",
              ...args,
            ]);
            return {
              activeIntents: [
                "must-not-be-proof",
              ],
            } as never;
          },
        evaluateJourney:
          (evidence: any) => {
            calls.push([
              "evaluate",
              evidence,
            ]);
            assert.deepEqual(
              evidence.activeIntents,
              []
            );
            return {
              evidenceFingerprint:
                "evidence-after",
              outcomeEvidence: {
                accessEligibilitySatisfied:
                  true,
              },
            } as never;
          },
      }
    );

  assert.deepEqual(
    result.completion,
    {
      kind: "SUCCEEDED",
      outcomeEvidenceFingerprint:
        "evidence-after",
    }
  );
  assert.equal(
    result.externalSideEffects,
    0
  );
  assert.equal(
    (calls[0] as any[])[3].persist,
    true
  );
  assert.deepEqual(
    (calls[0] as any[])[3]
      .expectedScope,
    {
      organizationId: "org-1",
      propertyId: "property-1",
    }
  );
  assert.deepEqual(
    (calls[1] as any[])[4],
    {
      organizationId: "org-1",
      propertyId: "property-1",
    }
  );
});

test("waits for evidence instead of treating domain blockers as execution failures", async () => {
  const result =
    await executeGuestJourneyAccessEvaluationHandler(
      {} as never,
      claim(),
      { now: NOW },
      {
        evaluateReadiness:
          async () => readiness(false),
        loadEvidence:
          async () =>
            ({ activeIntents: [] }) as never,
        evaluateJourney: () =>
          ({
            evidenceFingerprint:
              "evidence-blocked",
            outcomeEvidence: {
              accessEligibilitySatisfied:
                false,
            },
          }) as never,
      }
    );

  assert.deepEqual(
    result.completion,
    {
      kind:
        "WAITING_FOR_EVIDENCE",
      outcomeEvidenceFingerprint:
        "evidence-blocked",
      errorCode:
        "ACCESS_EVIDENCE_PENDING",
      errorDetail:
        "PAYMENT_NOT_PAID",
    }
  );
});

test("does not accept readiness output without canonical confirmation", async () => {
  const result =
    await executeGuestJourneyAccessEvaluationHandler(
      {} as never,
      claim(),
      { now: NOW },
      {
        evaluateReadiness:
          async () => readiness(true),
        loadEvidence:
          async () =>
            ({ activeIntents: [] }) as never,
        evaluateJourney: () =>
          ({
            evidenceFingerprint:
              "evidence-not-confirmed",
            outcomeEvidence: {
              accessEligibilitySatisfied:
                false,
            },
          }) as never,
      }
    );

  assert.equal(
    result.completion.kind,
    "WAITING_FOR_EVIDENCE"
  );
});

test("rejects every non-registered owner Engine contract before execution", async () => {
  let executed = false;

  await assert.rejects(
    executeGuestJourneyAccessEvaluationHandler(
      {} as never,
      claim({
        targetEngine:
          "COMMUNICATIONS" as "ACCESS",
      }),
      { now: NOW },
      {
        evaluateReadiness:
          async () => {
            executed = true;
            return readiness(true);
          },
        loadEvidence:
          async () => ({}) as never,
        evaluateJourney: () =>
          ({}) as never,
      }
    ),
    /HANDLER_CONTRACT_MISMATCH/
  );

  assert.equal(executed, false);
});
