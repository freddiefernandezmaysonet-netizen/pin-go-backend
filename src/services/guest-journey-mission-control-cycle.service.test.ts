import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestJourneyCoordinationIntentStatus,
} from "@prisma/client";

import {
  runGuestJourneyMissionControlCycle,
} from "./guest-journey-mission-control-cycle.service";
import type {
  GuestJourneyMissionControlConfig,
} from "./guest-journey-mission-control.config";
import type {
  GuestJourneyOwnerRuntimeConfig,
} from "./guest-journey-owner-runtime.config";

const NOW = new Date(
  "2026-08-23T12:00:00.000Z"
);

function bridgeConfig(
  overrides: Partial<
    GuestJourneyMissionControlConfig
  > = {}
): GuestJourneyMissionControlConfig {
  return {
    enabled: true,
    batchSize: 25,
    lookbackDays: 30,
    organizationIds: ["org-1"],
    propertyIds: [],
    ...overrides,
  };
}

function ownerConfig(
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

function candidate(
  status:
    GuestJourneyCoordinationIntentStatus =
    GuestJourneyCoordinationIntentStatus.PENDING
) {
  return {
    id: "intent-1",
    reservationId: "reservation-1",
    status,
    targetEngine: "ACCESS",
    intentType:
      "REQUEST_ACCESS_EVALUATION",
    reasonCode: "ACCESS_PENDING",
    expectedOutcomeCode:
      "ACCESS_RELEASE_STATUS_ELIGIBLE",
    claimCount: 0,
    nextActionAt: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    succeededAt: null,
    exhaustedAt:
      status ===
      GuestJourneyCoordinationIntentStatus.EXHAUSTED
        ? NOW
        : null,
    supersededAt: null,
    reservation: {
      reservationNumber:
        "PG-2026-000123",
      guestName: "Guest",
      propertyId: "property-1",
      property: {
        organizationId: "org-1",
      },
    },
    attempts: [],
  };
}

function prismaCandidates(
  candidates: ReturnType<
    typeof candidate
  >[]
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

test("does no reads or writes while E6 is disabled", async () => {
  let read = false;
  let synced = false;
  const metrics =
    await runGuestJourneyMissionControlCycle(
      {
        guestJourneyCoordinationIntent: {
          findMany: async () => {
            read = true;
            return [];
          },
        },
      } as never,
      bridgeConfig({
        enabled: false,
        organizationIds: [],
      }),
      ownerConfig(),
      {
        dependencies: {
          sync: async () => {
            synced = true;
            throw new Error(
              "must not execute"
            );
          },
        },
      }
    );

  assert.equal(read, false);
  assert.equal(synced, false);
  assert.equal(metrics.enabled, false);
  assert.equal(
    metrics.operationalIssueWrites,
    0
  );
  assert.equal(
    metrics.externalSideEffects,
    0
  );
});

test("selects only E5 ACCESS evaluation intents inside the E6 canary scope", async () => {
  const harness = prismaCandidates([]);

  await runGuestJourneyMissionControlCycle(
    harness.prisma as never,
    bridgeConfig({
      propertyIds: ["property-1"],
    }),
    ownerConfig(),
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
  assert.equal(query.take, 25);
  assert.equal(
    JSON.stringify(query).includes(
      "REQUEST_ACCESS_PROVISIONING"
    ),
    false
  );
  assert.equal(
    JSON.stringify(query).includes(
      "leaseToken"
    ),
    false
  );
  assert.equal(
    JSON.stringify(query).includes(
      "payload"
    ),
    false
  );
});

test("projects runtime state, counts durable writes and advances the cursor", async () => {
  const harness = prismaCandidates([
    candidate(
      GuestJourneyCoordinationIntentStatus.EXHAUSTED
    ),
  ]);
  let ownerRuntimeEnabled:
    boolean | null = null;
  const metrics =
    await runGuestJourneyMissionControlCycle(
      harness.prisma as never,
      bridgeConfig({ batchSize: 1 }),
      ownerConfig(),
      {
        now: NOW,
        dependencies: {
          sync: async (
            _db,
            _intent,
            options
          ) => {
            ownerRuntimeEnabled =
              options.ownerRuntimeEnabled;
            return {
              lifecycle: "CREATED",
              escalation: "CREATED",
              operationalIssueWrites: 2,
              externalSideEffects: 0,
            };
          },
        },
      }
    );

  assert.equal(ownerRuntimeEnabled, true);
  assert.equal(metrics.selected, 1);
  assert.equal(metrics.projected, 1);
  assert.equal(metrics.created, 2);
  assert.equal(metrics.escalated, 1);
  assert.equal(
    metrics.operationalIssueWrites,
    2
  );
  assert.equal(
    metrics.nextCursor,
    "intent-1"
  );
  assert.equal(
    metrics.ownerEngineExecutions,
    0
  );
  assert.equal(metrics.credentialWrites, 0);
  assert.equal(metrics.messageSends, 0);
  assert.equal(metrics.paymentCalls, 0);
});

test("does not claim that an out-of-scope owner runtime is auto-resolving", async () => {
  const harness = prismaCandidates([
    candidate(),
  ]);
  let ownerRuntimeEnabled = true;

  await runGuestJourneyMissionControlCycle(
    harness.prisma as never,
    bridgeConfig(),
    ownerConfig({
      organizationIds: ["org-other"],
    }),
    {
      now: NOW,
      dependencies: {
        sync: async (
          _db,
          _intent,
          options
        ) => {
          ownerRuntimeEnabled =
            options.ownerRuntimeEnabled;
          return {
            lifecycle: "UNCHANGED",
            escalation: "NOT_REQUIRED",
            operationalIssueWrites: 0,
            externalSideEffects: 0,
          };
        },
      },
    }
  );

  assert.equal(
    ownerRuntimeEnabled,
    false
  );
});

test("isolates projection failures and reports stable error codes", async () => {
  const harness = prismaCandidates([
    candidate(),
  ]);
  const metrics =
    await runGuestJourneyMissionControlCycle(
      harness.prisma as never,
      bridgeConfig(),
      ownerConfig(),
      {
        now: NOW,
        dependencies: {
          sync: async () => {
            throw new Error(
              "OPERATIONAL_DB_UNAVAILABLE: retry later"
            );
          },
        },
      }
    );

  assert.equal(metrics.projected, 0);
  assert.equal(metrics.errors, 1);
  assert.equal(
    metrics.errorCodeCounts
      .OPERATIONAL_DB_UNAVAILABLE,
    1
  );
});

test("fails closed if enabled without E6 tenant scope", async () => {
  await assert.rejects(
    runGuestJourneyMissionControlCycle(
      {} as never,
      bridgeConfig({
        organizationIds: [],
        propertyIds: [],
      }),
      ownerConfig(),
      { now: NOW }
    ),
    /MISSION_CONTROL_BRIDGE_SCOPE_REQUIRED/
  );
});

test("does not mark a same-tenant intent outside the owner property subset as auto-resolving", async () => {
  const outsideSubset = candidate();
  outsideSubset.reservation.propertyId = "property-2";
  const harness = prismaCandidates([
    outsideSubset,
  ]);
  let ownerRuntimeEnabled = true;

  await runGuestJourneyMissionControlCycle(
    harness.prisma as never,
    bridgeConfig({
      propertyIds: ["property-1"],
    }),
    ownerConfig({
      propertyIds: ["property-1"],
    }),
    {
      now: NOW,
      dependencies: {
        sync: async (
          _db,
          _intent,
          options
        ) => {
          ownerRuntimeEnabled =
            options.ownerRuntimeEnabled;
          return {
            lifecycle: "UNCHANGED",
            escalation: "NOT_REQUIRED",
            operationalIssueWrites: 0,
            externalSideEffects: 0,
          };
        },
      },
    }
  );

  assert.equal(
    ownerRuntimeEnabled,
    false
  );
});
