import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import {
  recordAccessRecoveryOperationalFailure,
  resolveAccessRecoveryOperationalIssue,
} from "../access-recovery-operational.service";

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

  const accessGrant = {
    id: "grant-1",
    reservationId: "reservation-1",
    reservation: {
      reservationNumber: "PG-1001",
      guestName: "Test Guest",
      propertyId: "property-1",
      property: {
        name: "Ocean Villa",
        organizationId: "org-1",
      },
    },
    lock: {
      id: "lock-1",
      propertyId: "property-1",
      locationLabel: "Front Door",
      ttlockLockName: "Ocean Villa Lock",
      property: {
        name: "Ocean Villa",
        organizationId: "org-1",
      },
    },
  };

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
    accessGrant: {
      findUnique: async (args: any) =>
        args.where.id === accessGrant.id
          ? accessGrant
          : null,
    },

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

function getOnlyIssue(
  issues: Map<string, StoredIssue>
) {
  assert.equal(issues.size, 1);

  const issue =
    Array.from(issues.values())[0];

  assert.ok(issue);

  return issue;
}

test("keeps Access blue while retry budget remains and deduplicates repeated failures", async () => {
  const harness =
    createPrismaHarness();

  const firstFailureAt = new Date(
    "2026-07-24T12:00:00.000Z"
  );
  const firstNextAttemptAt = new Date(
    "2026-07-24T12:05:00.000Z"
  );

  const firstResult =
    await recordAccessRecoveryOperationalFailure({
      prisma: harness.prisma,
      accessGrantId: "grant-1",
      operation: "REVOKE",
      attemptCount: 2,
      maxAttempts: 7,
      lastError:
        "TTLock gateway temporarily unavailable",
      nextAttemptAt:
        firstNextAttemptAt,
      exhausted: false,
      occurredAt: firstFailureAt,
    });

  assert.equal(firstResult.applied, true);

  const firstIssue = getOnlyIssue(
    harness.issues
  );

  assert.equal(
    firstIssue.operationalKey,
    "ACCESS_RECOVERY:REVOKE:grant-1"
  );
  assert.equal(
    firstIssue.issueCode,
    "ACCESS_REVOKE_RETRY_SCHEDULED"
  );
  assert.equal(
    firstIssue.workflowState,
    "WAITING"
  );
  assert.equal(
    firstIssue.actionRequired,
    false
  );
  assert.equal(
    firstIssue.responsibleActor,
    "PIN_GO"
  );
  assert.equal(
    firstIssue.canAutoResolve,
    true
  );
  assert.equal(
    firstIssue.metadata.attempt,
    2
  );
  assert.equal(
    firstIssue.metadata.maxAttempts,
    7
  );
  assert.equal(
    firstIssue.metadata.exhausted,
    false
  );
  assert.equal(
    firstIssue.metadata.nextAttemptAt,
    firstNextAttemptAt.toISOString()
  );
  assert.equal(
    harness.transitions.length,
    1
  );
  assert.equal(
    harness.transitions[0]
      ?.fromWorkflowState,
    null
  );
  assert.equal(
    harness.transitions[0]
      ?.toWorkflowState,
    "WAITING"
  );

  const secondNextAttemptAt = new Date(
    "2026-07-24T12:15:00.000Z"
  );

  const secondResult =
    await recordAccessRecoveryOperationalFailure({
      prisma: harness.prisma,
      accessGrantId: "grant-1",
      operation: "REVOKE",
      attemptCount: 3,
      maxAttempts: 7,
      lastError:
        "TTLock gateway still unavailable",
      nextAttemptAt:
        secondNextAttemptAt,
      exhausted: false,
      occurredAt: new Date(
        "2026-07-24T12:10:00.000Z"
      ),
    });

  assert.equal(secondResult.applied, true);
  assert.equal(harness.issues.size, 1);
  assert.equal(
    harness.transitions.length,
    1
  );

  const updatedIssue = getOnlyIssue(
    harness.issues
  );

  assert.equal(
    updatedIssue.id,
    firstIssue.id
  );
  assert.equal(
    updatedIssue.metadata.attempt,
    3
  );
  assert.equal(
    updatedIssue.metadata.nextAttemptAt,
    secondNextAttemptAt.toISOString()
  );
});

test("moves the same Access workflow from blue to red only after exhaustion", async () => {
  const harness =
    createPrismaHarness();

  await recordAccessRecoveryOperationalFailure({
    prisma: harness.prisma,
    accessGrantId: "grant-1",
    operation: "REVOKE",
    attemptCount: 6,
    maxAttempts: 7,
    lastError:
      "TTLock gateway unavailable",
    nextAttemptAt: new Date(
      "2026-07-24T18:00:00.000Z"
    ),
    exhausted: false,
    occurredAt: new Date(
      "2026-07-24T12:00:00.000Z"
    ),
  });

  const blueIssue = getOnlyIssue(
    harness.issues
  );

  await recordAccessRecoveryOperationalFailure({
    prisma: harness.prisma,
    accessGrantId: "grant-1",
    operation: "REVOKE",
    attemptCount: 7,
    maxAttempts: 7,
    lastError:
      "TTLock gateway unavailable after final attempt",
    nextAttemptAt: null,
    exhausted: true,
    occurredAt: new Date(
      "2026-07-24T18:00:00.000Z"
    ),
  });

  const redIssue = getOnlyIssue(
    harness.issues
  );

  assert.equal(redIssue.id, blueIssue.id);
  assert.equal(
    redIssue.issueCode,
    "ACCESS_REVOKE_RECOVERY_EXHAUSTED"
  );
  assert.equal(
    redIssue.workflowState,
    "ACTION_REQUIRED"
  );
  assert.equal(
    redIssue.actionRequired,
    true
  );
  assert.equal(
    redIssue.responsibleActor,
    "HOST"
  );
  assert.equal(
    redIssue.canAutoResolve,
    false
  );
  assert.equal(
    redIssue.autoResolveStatus,
    "NOT_SUPPORTED"
  );
  assert.equal(
    redIssue.metadata.attempt,
    7
  );
  assert.equal(
    redIssue.metadata.maxAttempts,
    7
  );
  assert.equal(
    redIssue.metadata.exhausted,
    true
  );
  assert.equal(
    redIssue.metadata.nextAttemptAt,
    null
  );
  assert.equal(
    harness.transitions.length,
    2
  );
  assert.equal(
    harness.transitions[1]
      ?.fromWorkflowState,
    "WAITING"
  );
  assert.equal(
    harness.transitions[1]
      ?.toWorkflowState,
    "ACTION_REQUIRED"
  );
});

test("resolves the same Access workflow automatically after recovery", async () => {
  const harness =
    createPrismaHarness();

  await recordAccessRecoveryOperationalFailure({
    prisma: harness.prisma,
    accessGrantId: "grant-1",
    operation: "REVOKE",
    attemptCount: 2,
    maxAttempts: 7,
    lastError:
      "Temporary TTLock failure",
    nextAttemptAt: new Date(
      "2026-07-24T12:05:00.000Z"
    ),
    exhausted: false,
    occurredAt: new Date(
      "2026-07-24T12:00:00.000Z"
    ),
  });

  const waitingIssue = getOnlyIssue(
    harness.issues
  );

  const resolvedResult =
    await resolveAccessRecoveryOperationalIssue({
      prisma: harness.prisma,
      accessGrantId: "grant-1",
      operation: "REVOKE",
      occurredAt: new Date(
        "2026-07-24T12:04:00.000Z"
      ),
    });

  assert.equal(
    resolvedResult.applied,
    true
  );

  const resolvedIssue = getOnlyIssue(
    harness.issues
  );

  assert.equal(
    resolvedIssue.id,
    waitingIssue.id
  );
  assert.equal(
    resolvedIssue.issueCode,
    "ACCESS_REVOKE_RECOVERED"
  );
  assert.equal(
    resolvedIssue.workflowState,
    "RESOLVED"
  );
  assert.equal(
    resolvedIssue.actionRequired,
    false
  );
  assert.equal(
    resolvedIssue.responsibleActor,
    "NONE"
  );
  assert.equal(
    resolvedIssue.resolutionType,
    "AUTOMATIC"
  );
  assert.equal(
    resolvedIssue.resolvedBy,
    "PIN_GO"
  );
  assert.equal(
    harness.transitions.length,
    2
  );
  assert.equal(
    harness.transitions[1]
      ?.fromWorkflowState,
    "WAITING"
  );
  assert.equal(
    harness.transitions[1]
      ?.toWorkflowState,
    "RESOLVED"
  );
});

test("normal Access success does not create resolved operational noise", async () => {
  const harness =
    createPrismaHarness();

  const result =
    await resolveAccessRecoveryOperationalIssue({
      prisma: harness.prisma,
      accessGrantId: "grant-1",
      operation: "REVOKE",
      occurredAt: new Date(
        "2026-07-24T12:00:00.000Z"
      ),
    });

  assert.equal(result.applied, false);
  assert.equal(
    result.reason,
    "OPERATIONAL_ISSUE_NOT_FOUND"
  );
  assert.equal(harness.issues.size, 0);
  assert.equal(
    harness.transitions.length,
    0
  );
});
