import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestJourneyState,
  ReservationStatus,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import {
  synchronizeGuestJourneyOperationalIssue,
} from "../guest-journey-operational.service";

type StoredIssue = Record<string, any> & {
  id: string;
  operationalKey: string;
  issueCode: string;
  workflowState: string;
  reopenedCount: number;
};

function createPrismaHarness() {
  const issues = new Map<
    string,
    StoredIssue
  >();
  const transitions: Array<
    Record<string, any>
  > = [];

  const transaction = {
    operationalIssue: {
      findUnique: async (args: any) =>
        issues.get(
          String(
            args.where.operationalKey
          )
        ) ?? null,

      upsert: async (args: any) => {
        const operationalKey = String(
          args.where.operationalKey
        );
        const current =
          issues.get(operationalKey) ?? null;

        if (!current) {
          const created: StoredIssue = {
            id: `issue-${issues.size + 1}`,
            reopenedCount: 0,
            ...args.create,
          };

          issues.set(
            operationalKey,
            created
          );

          return created;
        }

        const next: StoredIssue = {
          ...current,
          ...args.update,
        };

        if (
          args.update.reopenedCount
            ?.increment
        ) {
          next.reopenedCount =
            current.reopenedCount +
            Number(
              args.update.reopenedCount
                .increment
            );
        }

        issues.set(operationalKey, next);

        return next;
      },
    },

    operationalIssueTransition: {
      create: async (args: any) => {
        const transition = {
          id: `transition-${
            transitions.length + 1
          }`,
          ...args.data,
        };

        transitions.push(transition);

        return transition;
      },
    },
  };

  const prisma = {
    operationalIssue: {
      findUnique: async (args: any) =>
        issues.get(
          String(
            args.where.operationalKey
          )
        ) ?? null,
    },

    $transaction: async (
      callback: (
        tx: typeof transaction
      ) => Promise<unknown>
    ) => callback(transaction),
  } as unknown as PrismaClient;

  return {
    prisma,
    issues,
    transitions,
  };
}

function baseInput(
  prisma: PrismaClient,
  input: {
    currentState: GuestJourneyState;
    checkIn: Date;
    occurredAt: Date;
  }
) {
  return {
    prisma,
    journeyId: "journey-1",
    reservationId: "reservation-1",
    reservationNumber: "PG-5001",
    guestName: "Journey Guest",
    organizationId: "org-1",
    propertyId: "property-1",
    propertyName: "Ocean Villa",
    reservationStatus:
      ReservationStatus.ACTIVE,
    checkIn: input.checkIn,
    checkOut: new Date(
      input.checkIn.getTime() +
        48 * 60 * 60 * 1000
    ),
    currentState: input.currentState,
    stateChangedAt: new Date(
      input.occurredAt.getTime() -
        60 * 60 * 1000
    ),
    guestAccessReleaseStatus:
      "PENDING",
    occurredAt: input.occurredAt,
  };
}

function getOnlyIssue(
  issues: Map<string, StoredIssue>
) {
  assert.equal(issues.size, 1);

  const issue =
    Array.from(issues.values())[0];

  assert.ok(issue);
  return issue;
}

test("keeps verification pending blue while more than two hours remain", async () => {
  const harness =
    createPrismaHarness();
  const occurredAt = new Date(
    "2026-07-24T12:00:00.000Z"
  );
  const checkIn = new Date(
    "2026-07-24T17:00:00.000Z"
  );

  await synchronizeGuestJourneyOperationalIssue(
    baseInput(harness.prisma, {
      currentState:
        GuestJourneyState.VERIFICATION_PENDING,
      checkIn,
      occurredAt,
    })
  );

  const issue = getOnlyIssue(
    harness.issues
  );

  assert.equal(
    issue.operationalKey,
    "GUEST_JOURNEY:reservation-1"
  );
  assert.equal(
    issue.issueCode,
    "GUEST_VERIFICATION_MONITORING"
  );
  assert.equal(
    issue.engine,
    "GUEST_JOURNEY"
  );
  assert.equal(
    issue.workflowState,
    "WAITING"
  );
  assert.equal(issue.actionRequired, false);
  assert.equal(
    issue.responsibleActor,
    "GUEST"
  );
  assert.equal(issue.canAutoResolve, true);
  assert.equal(
    issue.metadata.nextAttemptAt,
    "2026-07-24T15:00:00.000Z"
  );
  assert.equal(
    issue.metadata.exhausted,
    false
  );
});

test("turns verification pending red only inside the two-hour host-action window", async () => {
  const harness =
    createPrismaHarness();
  const occurredAt = new Date(
    "2026-07-24T12:00:00.000Z"
  );
  const checkIn = new Date(
    "2026-07-24T13:30:00.000Z"
  );

  await synchronizeGuestJourneyOperationalIssue(
    baseInput(harness.prisma, {
      currentState:
        GuestJourneyState.VERIFICATION_PENDING,
      checkIn,
      occurredAt,
    })
  );

  const issue = getOnlyIssue(
    harness.issues
  );

  assert.equal(
    issue.issueCode,
    "GUEST_VERIFICATION_HOST_ACTION_REQUIRED"
  );
  assert.equal(
    issue.workflowState,
    "ACTION_REQUIRED"
  );
  assert.equal(issue.actionRequired, true);
  assert.equal(
    issue.responsibleActor,
    "HOST"
  );
  assert.equal(issue.canAutoResolve, false);
  assert.equal(
    issue.autoResolveStatus,
    "NOT_SUPPORTED"
  );
  assert.equal(
    issue.metadata.exhausted,
    true
  );
  assert.equal(
    issue.metadata.nextAttemptAt,
    null
  );
});

test("keeps verification-completed journeys blue while Access owns credential preparation", async () => {
  const harness =
    createPrismaHarness();
  const occurredAt = new Date(
    "2026-07-24T12:00:00.000Z"
  );

  await synchronizeGuestJourneyOperationalIssue(
    baseInput(harness.prisma, {
      currentState:
        GuestJourneyState.VERIFICATION_COMPLETED,
      checkIn: new Date(
        "2026-07-24T17:00:00.000Z"
      ),
      occurredAt,
    })
  );

  const scheduledIssue = getOnlyIssue(
    harness.issues
  );

  assert.equal(
    scheduledIssue.issueCode,
    "GUEST_ACCESS_PREPARATION_SCHEDULED"
  );
  assert.equal(
    scheduledIssue.workflowState,
    "WAITING"
  );
  assert.equal(
    scheduledIssue.actionRequired,
    false
  );
  assert.equal(
    scheduledIssue.responsibleActor,
    "PIN_GO"
  );

  await synchronizeGuestJourneyOperationalIssue(
    baseInput(harness.prisma, {
      currentState:
        GuestJourneyState.VERIFICATION_COMPLETED,
      checkIn: new Date(
        "2026-07-24T13:30:00.000Z"
      ),
      occurredAt: new Date(
        "2026-07-24T12:10:00.000Z"
      ),
    })
  );

  const runningIssue = getOnlyIssue(
    harness.issues
  );

  assert.equal(
    runningIssue.id,
    scheduledIssue.id
  );
  assert.equal(
    runningIssue.issueCode,
    "GUEST_ACCESS_PREPARATION_RUNNING"
  );
  assert.equal(
    runningIssue.workflowState,
    "AUTO_RESOLVING"
  );
  assert.equal(
    runningIssue.actionRequired,
    false
  );
  assert.equal(
    runningIssue.autoResolveStatus,
    "RUNNING"
  );
});

test("keeps access-scheduled journeys blue and resolves the same issue at ready for arrival", async () => {
  const harness =
    createPrismaHarness();
  const occurredAt = new Date(
    "2026-07-24T12:00:00.000Z"
  );
  const checkIn = new Date(
    "2026-07-24T13:30:00.000Z"
  );

  await synchronizeGuestJourneyOperationalIssue(
    baseInput(harness.prisma, {
      currentState:
        GuestJourneyState.ACCESS_SCHEDULED,
      checkIn,
      occurredAt,
    })
  );

  const runningIssue = getOnlyIssue(
    harness.issues
  );

  assert.equal(
    runningIssue.issueCode,
    "GUEST_ARRIVAL_READINESS_RUNNING"
  );
  assert.equal(
    runningIssue.workflowState,
    "AUTO_RESOLVING"
  );
  assert.equal(
    runningIssue.actionRequired,
    false
  );

  await synchronizeGuestJourneyOperationalIssue(
    baseInput(harness.prisma, {
      currentState:
        GuestJourneyState.READY_FOR_ARRIVAL,
      checkIn,
      occurredAt: new Date(
        "2026-07-24T12:05:00.000Z"
      ),
    })
  );

  const resolvedIssue = getOnlyIssue(
    harness.issues
  );

  assert.equal(
    resolvedIssue.id,
    runningIssue.id
  );
  assert.equal(
    resolvedIssue.issueCode,
    "GUEST_JOURNEY_READY_FOR_ARRIVAL"
  );
  assert.equal(
    resolvedIssue.workflowState,
    "RESOLVED"
  );
  assert.equal(
    resolvedIssue.resolutionType,
    "AUTOMATIC"
  );
  assert.equal(
    resolvedIssue.resolvedBy,
    "PIN_GO"
  );
});

test("supersedes an active guest journey when the reservation is cancelled", async () => {
  const harness =
    createPrismaHarness();
  const occurredAt = new Date(
    "2026-07-24T12:00:00.000Z"
  );
  const checkIn = new Date(
    "2026-07-24T17:00:00.000Z"
  );

  await synchronizeGuestJourneyOperationalIssue(
    baseInput(harness.prisma, {
      currentState:
        GuestJourneyState.VERIFICATION_PENDING,
      checkIn,
      occurredAt,
    })
  );

  const waitingIssue = getOnlyIssue(
    harness.issues
  );

  await synchronizeGuestJourneyOperationalIssue({
    ...baseInput(harness.prisma, {
      currentState:
        GuestJourneyState.VERIFICATION_PENDING,
      checkIn,
      occurredAt: new Date(
        "2026-07-24T12:05:00.000Z"
      ),
    }),
    reservationStatus:
      ReservationStatus.CANCELLED,
  });

  const supersededIssue = getOnlyIssue(
    harness.issues
  );

  assert.equal(
    supersededIssue.id,
    waitingIssue.id
  );
  assert.equal(
    supersededIssue.issueCode,
    "GUEST_JOURNEY_SUPERSEDED"
  );
  assert.equal(
    supersededIssue.workflowState,
    "RESOLVED"
  );
  assert.equal(
    supersededIssue.resolutionType,
    "SUPERSEDED"
  );
});

test("coalesces identical guest journey signals inside five minutes", async () => {
  const harness =
    createPrismaHarness();
  const checkIn = new Date(
    "2026-07-24T17:00:00.000Z"
  );

  await synchronizeGuestJourneyOperationalIssue(
    baseInput(harness.prisma, {
      currentState:
        GuestJourneyState.VERIFICATION_PENDING,
      checkIn,
      occurredAt: new Date(
        "2026-07-24T12:00:00.000Z"
      ),
    })
  );

  const firstIssue = getOnlyIssue(
    harness.issues
  );
  const firstTransitionCount =
    harness.transitions.length;

  const result =
    await synchronizeGuestJourneyOperationalIssue(
      baseInput(harness.prisma, {
        currentState:
          GuestJourneyState.VERIFICATION_PENDING,
        checkIn,
        occurredAt: new Date(
          "2026-07-24T12:02:00.000Z"
        ),
      })
    );

  assert.equal(result.applied, false);
  assert.equal(result.coalesced, true);
  assert.equal(harness.issues.size, 1);
  assert.equal(
    getOnlyIssue(harness.issues).id,
    firstIssue.id
  );
  assert.equal(
    harness.transitions.length,
    firstTransitionCount
  );
});
