import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestJourneyCoordinationIntentStatus,
} from "@prisma/client";

import {
  projectGuestJourneyOwnerIntentToMissionControl,
  syncGuestJourneyOwnerIntentMissionControl,
} from "./guest-journey-mission-control-bridge.service";
import type {
  GuestJourneyMissionControlIntent,
} from "./guest-journey-mission-control-bridge.service";

const NOW = new Date(
  "2026-08-23T12:00:00.000Z"
);

function intent(
  status:
    GuestJourneyCoordinationIntentStatus,
  overrides: Partial<
    GuestJourneyMissionControlIntent
  > = {}
): GuestJourneyMissionControlIntent {
  return {
    id: "intent-1",
    reservationId: "reservation-1",
    status,
    targetEngine: "ACCESS",
    intentType:
      "REQUEST_ACCESS_EVALUATION",
    reasonCode:
      "ACCESS_ELIGIBILITY_NOT_CONFIRMED",
    expectedOutcomeCode:
      "ACCESS_RELEASE_STATUS_ELIGIBLE",
    claimCount: 1,
    nextActionAt: null,
    lastError: null,
    createdAt: new Date(
      NOW.getTime() - 60_000
    ),
    updatedAt: NOW,
    succeededAt:
      status ===
      GuestJourneyCoordinationIntentStatus.SUCCEEDED
        ? NOW
        : null,
    exhaustedAt:
      status ===
      GuestJourneyCoordinationIntentStatus.EXHAUSTED
        ? NOW
        : null,
    supersededAt:
      status ===
      GuestJourneyCoordinationIntentStatus.SUPERSEDED
        ? NOW
        : null,
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
    ...overrides,
  };
}

test("projects queued and claimed intents as host-safe autonomous work only when the owner runtime is enabled", () => {
  const queued =
    projectGuestJourneyOwnerIntentToMissionControl(
      intent(
        GuestJourneyCoordinationIntentStatus.PENDING
      ),
      { ownerRuntimeEnabled: false }
    );
  const claimed =
    projectGuestJourneyOwnerIntentToMissionControl(
      intent(
        GuestJourneyCoordinationIntentStatus.CLAIMED
      ),
      { ownerRuntimeEnabled: true }
    );

  assert.equal(
    queued.lifecycle.workflowState,
    "WAITING"
  );
  assert.equal(
    queued.lifecycle.visibility,
    "HOST"
  );
  assert.equal(
    queued.lifecycle.actionRequired,
    false
  );
  assert.equal(
    queued.lifecycle.autoResolveStatus,
    "NOT_SUPPORTED"
  );

  assert.equal(
    claimed.lifecycle.workflowState,
    "AUTO_RESOLVING"
  );
  assert.equal(
    claimed.lifecycle.autoResolveStatus,
    "RUNNING"
  );
  assert.equal(
    claimed.lifecycle.canAutoResolve,
    true
  );
});

test("separates host-safe exhaustion from the internal developer escalation", () => {
  const projection =
    projectGuestJourneyOwnerIntentToMissionControl(
      intent(
        GuestJourneyCoordinationIntentStatus.EXHAUSTED,
        {
          lastError:
            "DATABASE_UNAVAILABLE: credentials must not be exposed",
          attempts: [
            {
              outcome: "EXHAUSTED",
              errorCode:
                "DATABASE_UNAVAILABLE",
              completedAt: NOW,
            },
          ],
        }
      ),
      { ownerRuntimeEnabled: true }
    );

  assert.equal(
    projection.lifecycle.workflowState,
    "WAITING"
  );
  assert.equal(
    projection.lifecycle.visibility,
    "HOST"
  );
  assert.equal(
    projection.lifecycle.actionRequired,
    false
  );
  assert.equal(
    projection.escalation
      ?.workflowState,
    "ACTION_REQUIRED"
  );
  assert.equal(
    projection.escalation?.visibility,
    "DEVELOPER"
  );
  assert.equal(
    projection.escalation
      ?.actionRequired,
    true
  );

  const serialized =
    JSON.stringify(projection);
  assert.doesNotMatch(
    serialized,
    /credentials must not be exposed/
  );
  assert.doesNotMatch(
    serialized,
    /leaseToken|payload/i
  );
  assert.match(
    serialized,
    /DATABASE_UNAVAILABLE/
  );
});

test("resolves successful and superseded lifecycle projections automatically", () => {
  const succeeded =
    projectGuestJourneyOwnerIntentToMissionControl(
      intent(
        GuestJourneyCoordinationIntentStatus.SUCCEEDED
      ),
      { ownerRuntimeEnabled: true }
    );
  const superseded =
    projectGuestJourneyOwnerIntentToMissionControl(
      intent(
        GuestJourneyCoordinationIntentStatus.SUPERSEDED
      ),
      { ownerRuntimeEnabled: true }
    );

  assert.equal(
    succeeded.lifecycle.workflowState,
    "RESOLVED"
  );
  assert.equal(
    succeeded.lifecycle.resolutionType,
    "AUTOMATIC"
  );
  assert.equal(
    superseded.lifecycle.resolutionType,
    "SUPERSEDED"
  );
  assert.equal(
    succeeded.escalation,
    null
  );
});

test("rejects intents outside the E5 ACCESS evaluation boundary", () => {
  assert.throws(
    () =>
      projectGuestJourneyOwnerIntentToMissionControl(
        intent(
          GuestJourneyCoordinationIntentStatus.PENDING,
          {
            intentType:
              "REQUEST_ACCESS_PROVISIONING",
          }
        ),
        { ownerRuntimeEnabled: true }
      ),
    /MISSION_CONTROL_INTENT_UNSUPPORTED/
  );
});

function prismaHarness(
  records: Record<
    string,
    Record<string, unknown> | null
  > = {},
  scopeCount = 1
) {
  return {
    guestJourneyCoordinationIntent: {
      count: async () => scopeCount,
    },
    operationalIssue: {
      findUnique: async (query: any) =>
        records[
          query.where.operationalKey
        ] ?? null,
    },
  };
}

test("creates lifecycle and escalation workflows idempotently without external effects", async () => {
  const upserts: any[] = [];
  const result =
    await syncGuestJourneyOwnerIntentMissionControl(
      prismaHarness() as never,
      intent(
        GuestJourneyCoordinationIntentStatus.EXHAUSTED
      ),
      {
        ownerRuntimeEnabled: true,
        expectedScope: {
          organizationId: "org-1",
          propertyId: "property-1",
        },
      },
      {
        upsert: async (_db, input) => {
          upserts.push(input);
          return {} as never;
        },
        reopen: async () =>
          ({} as never),
      }
    );

  assert.equal(upserts.length, 2);
  assert.equal(
    result.lifecycle,
    "CREATED"
  );
  assert.equal(
    result.escalation,
    "CREATED"
  );
  assert.equal(
    result.operationalIssueWrites,
    2
  );
  assert.equal(
    result.externalSideEffects,
    0
  );
});

test("reopens a reactivated lifecycle explicitly before the idempotent upsert", async () => {
  const calls: string[] = [];
  const key =
    "GUEST_JOURNEY_OWNER_RUNTIME:intent-1";
  const result =
    await syncGuestJourneyOwnerIntentMissionControl(
      prismaHarness({
        [key]: {
          workflowState: "RESOLVED",
          issueCode:
            "GUEST_JOURNEY_OWNER_RUNTIME_STATUS",
          lastSignalAt: new Date(
            NOW.getTime() - 10_000
          ),
        },
      }) as never,
      intent(
        GuestJourneyCoordinationIntentStatus.PENDING
      ),
      {
        ownerRuntimeEnabled: true,
        expectedScope: {
          organizationId: "org-1",
          propertyId: "property-1",
        },
      },
      {
        reopen: async () => {
          calls.push("reopen");
          return {} as never;
        },
        upsert: async () => {
          calls.push("upsert");
          return {} as never;
        },
      }
    );

  assert.deepEqual(calls, [
    "reopen",
    "upsert",
  ]);
  assert.equal(
    result.lifecycle,
    "REOPENED"
  );
  assert.equal(
    result.operationalIssueWrites,
    2
  );
});

test("resolves an existing developer escalation when the intent succeeds", async () => {
  const lifecycleKey =
    "GUEST_JOURNEY_OWNER_RUNTIME:intent-1";
  const escalationKey =
    "GUEST_JOURNEY_OWNER_RUNTIME_ESCALATION:intent-1";
  const upserts: any[] = [];
  const result =
    await syncGuestJourneyOwnerIntentMissionControl(
      prismaHarness({
        [lifecycleKey]: null,
        [escalationKey]: {
          workflowState:
            "ACTION_REQUIRED",
          issueCode:
            "GUEST_JOURNEY_OWNER_RUNTIME_EXHAUSTED",
          firstDetectedAt: new Date(
            NOW.getTime() - 20_000
          ),
          lastSignalAt: new Date(
            NOW.getTime() - 10_000
          ),
        },
      }) as never,
      intent(
        GuestJourneyCoordinationIntentStatus.SUCCEEDED
      ),
      {
        ownerRuntimeEnabled: true,
        expectedScope: {
          organizationId: "org-1",
          propertyId: "property-1",
        },
      },
      {
        reopen: async () =>
          ({} as never),
        upsert: async (_db, input) => {
          upserts.push(input);
          return {} as never;
        },
      }
    );

  assert.equal(upserts.length, 2);
  assert.equal(
    upserts[1].workflowState,
    "RESOLVED"
  );
  assert.equal(
    result.escalation,
    "UPDATED"
  );
  assert.equal(
    result.operationalIssueWrites,
    2
  );
});

test("does not write when the reservation leaves the E6 canary scope", async () => {
  let writes = 0;

  await assert.rejects(
    syncGuestJourneyOwnerIntentMissionControl(
      prismaHarness({}, 0) as never,
      intent(
        GuestJourneyCoordinationIntentStatus.PENDING
      ),
      {
        ownerRuntimeEnabled: true,
        expectedScope: {
          organizationId: "org-1",
          propertyId: "property-1",
        },
      },
      {
        reopen: async () => {
          writes += 1;
          return {} as never;
        },
        upsert: async () => {
          writes += 1;
          return {} as never;
        },
      }
    ),
    /MISSION_CONTROL_SCOPE_CHANGED/
  );

  assert.equal(writes, 0);
});

test("performs no duplicate write for an unchanged projected signal", async () => {
  const key =
    "GUEST_JOURNEY_OWNER_RUNTIME:intent-1";
  let writes = 0;
  const result =
    await syncGuestJourneyOwnerIntentMissionControl(
      prismaHarness({
        [key]: {
          workflowState:
            "AUTO_RESOLVING",
          issueCode:
            "GUEST_JOURNEY_OWNER_RUNTIME_STATUS",
          lastSignalAt: NOW,
        },
      }) as never,
      intent(
        GuestJourneyCoordinationIntentStatus.PENDING
      ),
      {
        ownerRuntimeEnabled: true,
        expectedScope: {
          organizationId: "org-1",
          propertyId: "property-1",
        },
      },
      {
        reopen: async () => {
          writes += 1;
          return {} as never;
        },
        upsert: async () => {
          writes += 1;
          return {} as never;
        },
      }
    );

  assert.equal(writes, 0);
  assert.equal(
    result.lifecycle,
    "UNCHANGED"
  );
  assert.equal(
    result.operationalIssueWrites,
    0
  );
});
