import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import {
  synchronizeCleaningCoverageOperationalIssue,
} from "../cleaning-operational.service";

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

  const reservation = {
    id: "reservation-1",
    reservationNumber: "PG-4001",
    guestName: "Cleaning Guest",
    status: "ACTIVE",
    checkOut: new Date(
      "2026-07-24T11:00:00.000Z"
    ),
    propertyId: "property-1",
    property: {
      name: "Ocean Villa",
      organizationId: "org-1",
      cleaningNfcEnabled: true,
    },
  };

  const cleaners = new Map([
    [
      "cleaner-1",
      {
        fullName: "Cleaner One",
      },
    ],
    [
      "cleaner-2",
      {
        fullName: "Cleaner Two",
      },
    ],
  ]);

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
    reservation: {
      findUnique: async (args: any) =>
        args.where.id === reservation.id
          ? reservation
          : null,
    },

    staffMember: {
      findUnique: async (args: any) =>
        cleaners.get(args.where.id) ?? null,
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
    reservation,
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

test("keeps cleaner confirmation blue after checkout while automatic fallback remains available", async () => {
  const harness =
    createPrismaHarness();
  const occurredAt = new Date(
    "2026-07-24T12:00:00.000Z"
  );
  const fallbackAt = new Date(
    "2026-07-24T14:00:00.000Z"
  );

  await synchronizeCleaningCoverageOperationalIssue({
    prisma: harness.prisma,
    reservationId: "reservation-1",
    confirmationId: "confirmation-1",
    staffMemberId: "cleaner-1",
    state: "WAITING_FOR_CLEANER",
    attemptedCleanerCount: 1,
    nextAttemptAt: fallbackAt,
    reason: "CONFIRMATION_SMS_SENT",
    occurredAt,
  });

  const issue = getOnlyIssue(
    harness.issues
  );

  assert.equal(
    issue.operationalKey,
    "CLEANING_COVERAGE:reservation-1"
  );
  assert.equal(
    issue.issueCode,
    "CLEANING_CONFIRMATION_WAITING"
  );
  assert.equal(issue.engine, "CLEANING");
  assert.equal(
    issue.workflowState,
    "WAITING"
  );
  assert.equal(issue.actionRequired, false);
  assert.equal(
    issue.responsibleActor,
    "PIN_GO"
  );
  assert.equal(
    issue.metadata.nextAttemptAt,
    fallbackAt.toISOString()
  );
  assert.equal(
    issue.metadata.exhausted,
    false
  );
  assert.equal(
    harness.transitions.length,
    1
  );
});

test("keeps the same coverage blue when a backup cleaner is assigned", async () => {
  const harness =
    createPrismaHarness();

  await synchronizeCleaningCoverageOperationalIssue({
    prisma: harness.prisma,
    reservationId: "reservation-1",
    confirmationId: "confirmation-1",
    staffMemberId: "cleaner-1",
    state: "WAITING_FOR_CLEANER",
    attemptedCleanerCount: 1,
    nextAttemptAt: new Date(
      "2026-07-24T14:00:00.000Z"
    ),
    occurredAt: new Date(
      "2026-07-24T12:00:00.000Z"
    ),
  });

  const firstIssue = getOnlyIssue(
    harness.issues
  );

  await synchronizeCleaningCoverageOperationalIssue({
    prisma: harness.prisma,
    reservationId: "reservation-1",
    confirmationId: "confirmation-2",
    staffMemberId: "cleaner-2",
    state: "BACKUP_ASSIGNED",
    attemptedCleanerCount: 1,
    reason: "FALLBACK_CREATED",
    occurredAt: new Date(
      "2026-07-24T14:00:00.000Z"
    ),
  });

  const backupIssue = getOnlyIssue(
    harness.issues
  );

  assert.equal(backupIssue.id, firstIssue.id);
  assert.equal(
    backupIssue.issueCode,
    "CLEANING_BACKUP_ASSIGNED"
  );
  assert.equal(
    backupIssue.workflowState,
    "WAITING"
  );
  assert.equal(
    backupIssue.actionRequired,
    false
  );
  assert.equal(
    backupIssue.staffMemberId,
    "cleaner-2"
  );
  assert.equal(
    backupIssue.cleanerName,
    "Cleaner Two"
  );
  assert.equal(
    harness.transitions.length,
    2
  );
});

test("moves the same coverage to red only when no backup remains", async () => {
  const harness =
    createPrismaHarness();

  await synchronizeCleaningCoverageOperationalIssue({
    prisma: harness.prisma,
    reservationId: "reservation-1",
    confirmationId: "confirmation-1",
    staffMemberId: "cleaner-1",
    state: "WAITING_FOR_CLEANER",
    nextAttemptAt: new Date(
      "2026-07-24T14:00:00.000Z"
    ),
    occurredAt: new Date(
      "2026-07-24T12:00:00.000Z"
    ),
  });

  const blueIssue = getOnlyIssue(
    harness.issues
  );

  await synchronizeCleaningCoverageOperationalIssue({
    prisma: harness.prisma,
    reservationId: "reservation-1",
    confirmationId: "confirmation-1",
    staffMemberId: "cleaner-1",
    state: "NO_BACKUP_AVAILABLE",
    attemptedCleanerCount: 2,
    reason: "NO_BACKUP_AVAILABLE",
    occurredAt: new Date(
      "2026-07-24T14:00:00.000Z"
    ),
  });

  const redIssue = getOnlyIssue(
    harness.issues
  );

  assert.equal(redIssue.id, blueIssue.id);
  assert.equal(
    redIssue.issueCode,
    "CLEANING_NO_BACKUP_AVAILABLE"
  );
  assert.equal(
    redIssue.workflowState,
    "ACTION_REQUIRED"
  );
  assert.equal(redIssue.actionRequired, true);
  assert.equal(
    redIssue.responsibleActor,
    "HOST"
  );
  assert.equal(
    redIssue.canAutoResolve,
    false
  );
  assert.equal(
    redIssue.metadata.attemptedCleanerCount,
    2
  );
  assert.equal(
    redIssue.metadata.exhausted,
    true
  );
});

test("resolves the same coverage when a cleaner confirms", async () => {
  const harness =
    createPrismaHarness();

  await synchronizeCleaningCoverageOperationalIssue({
    prisma: harness.prisma,
    reservationId: "reservation-1",
    confirmationId: "confirmation-2",
    staffMemberId: "cleaner-2",
    state: "BACKUP_ASSIGNED",
    occurredAt: new Date(
      "2026-07-24T12:00:00.000Z"
    ),
  });

  const waitingIssue = getOnlyIssue(
    harness.issues
  );

  await synchronizeCleaningCoverageOperationalIssue({
    prisma: harness.prisma,
    reservationId: "reservation-1",
    confirmationId: "confirmation-2",
    staffMemberId: "cleaner-2",
    state: "CONFIRMED",
    occurredAt: new Date(
      "2026-07-24T12:15:00.000Z"
    ),
  });

  const resolvedIssue = getOnlyIssue(
    harness.issues
  );

  assert.equal(
    resolvedIssue.id,
    waitingIssue.id
  );
  assert.equal(
    resolvedIssue.issueCode,
    "CLEANING_COVERAGE_CONFIRMED"
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
    "CLEANER"
  );
});

test("supersedes existing coverage when the reservation is cancelled", async () => {
  const harness =
    createPrismaHarness();

  await synchronizeCleaningCoverageOperationalIssue({
    prisma: harness.prisma,
    reservationId: "reservation-1",
    confirmationId: "confirmation-1",
    staffMemberId: "cleaner-1",
    state: "WAITING_FOR_CLEANER",
    occurredAt: new Date(
      "2026-07-24T12:00:00.000Z"
    ),
  });

  const waitingIssue = getOnlyIssue(
    harness.issues
  );

  harness.reservation.status =
    "CANCELLED";

  await synchronizeCleaningCoverageOperationalIssue({
    prisma: harness.prisma,
    reservationId: "reservation-1",
    confirmationId: "confirmation-1",
    staffMemberId: "cleaner-1",
    state: "WAITING_FOR_CLEANER",
    occurredAt: new Date(
      "2026-07-24T12:30:00.000Z"
    ),
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
    "CLEANING_COVERAGE_SUPERSEDED"
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
