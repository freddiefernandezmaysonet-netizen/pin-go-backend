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
  const issues = new Map<string, StoredIssue>();
  const transitions: Array<Record<string, any>> = [];

  const reservation = {
    id: "reservation-1",
    reservationNumber: "PG-4001",
    guestName: "Cleaning Guest",
    status: "ACTIVE",
    checkOut: new Date("2026-07-24T11:00:00.000Z"),
    propertyId: "property-1",
    property: {
      name: "Ocean Villa",
      organizationId: "org-1",
      cleaningNfcEnabled: true,
    },
  };

  const transaction = {
    operationalIssue: {
      findUnique: async (args: any) =>
        issues.get(String(args.where.operationalKey)) ?? null,
      upsert: async (args: any) => {
        const operationalKey = String(args.where.operationalKey);
        const current = issues.get(operationalKey) ?? null;

        if (!current) {
          const created: StoredIssue = {
            id: `issue-${issues.size + 1}`,
            reopenedCount: 0,
            ...args.create,
          };
          issues.set(operationalKey, created);
          return created;
        }

        const next: StoredIssue = {
          ...current,
          ...args.update,
        };

        if (args.update.reopenedCount?.increment) {
          next.reopenedCount =
            current.reopenedCount +
            Number(args.update.reopenedCount.increment);
        }

        issues.set(operationalKey, next);
        return next;
      },
    },
    operationalIssueTransition: {
      create: async (args: any) => {
        const transition = {
          id: `transition-${transitions.length + 1}`,
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
        args.where.id === reservation.id ? reservation : null,
    },
    staffMember: {
      findUnique: async () => ({
        fullName: "Cleaner One",
      }),
    },
    operationalIssue: {
      findUnique: async (args: any) =>
        issues.get(String(args.where.operationalKey)) ?? null,
    },
    $transaction: async (
      callback: (tx: typeof transaction) => Promise<unknown>
    ) => callback(transaction),
  } as unknown as PrismaClient;

  return {
    prisma,
    issues,
    transitions,
    reservation,
  };
}

function getOnlyIssue(issues: Map<string, StoredIssue>) {
  assert.equal(issues.size, 1);
  const issue = Array.from(issues.values())[0];
  assert.ok(issue);
  return issue;
}

test("keeps a failed cleaner notification retry under Pin&Go ownership", async () => {
  const harness = createPrismaHarness();
  const nextAttemptAt = new Date("2026-07-24T12:15:00.000Z");

  await synchronizeCleaningCoverageOperationalIssue({
    prisma: harness.prisma,
    reservationId: "reservation-1",
    confirmationId: "confirmation-1",
    staffMemberId: "cleaner-1",
    state: "DISPATCH_RETRY_SCHEDULED",
    nextAttemptAt,
    error: "Twilio temporarily unavailable",
    reason: "CONFIRMATION_SMS_FAILED",
    occurredAt: new Date("2026-07-24T12:00:00.000Z"),
  });

  const issue = getOnlyIssue(harness.issues);

  assert.equal(
    issue.issueCode,
    "CLEANING_CONFIRMATION_DISPATCH_RETRY_SCHEDULED"
  );
  assert.equal(issue.workflowState, "WAITING");
  assert.equal(issue.responsibleActor, "PIN_GO");
  assert.equal(issue.actionRequired, false);
  assert.equal(issue.canAutoResolve, true);
  assert.equal(
    issue.autoResolveActionCode,
    "RETRY_CLEANER_NOTIFICATION"
  );
  assert.equal(
    issue.metadata.nextAttemptAt,
    nextAttemptAt.toISOString()
  );
  assert.equal(issue.metadata.exhausted, false);
  assert.equal(
    issue.metadata.lastError,
    "Twilio temporarily unavailable"
  );
});

test("supersedes existing coverage when cleaning NFC is disabled", async () => {
  const harness = createPrismaHarness();

  await synchronizeCleaningCoverageOperationalIssue({
    prisma: harness.prisma,
    reservationId: "reservation-1",
    confirmationId: "confirmation-1",
    staffMemberId: "cleaner-1",
    state: "WAITING_FOR_CLEANER",
    occurredAt: new Date("2026-07-24T12:00:00.000Z"),
  });

  const waitingIssue = getOnlyIssue(harness.issues);
  harness.reservation.property.cleaningNfcEnabled = false;

  await synchronizeCleaningCoverageOperationalIssue({
    prisma: harness.prisma,
    reservationId: "reservation-1",
    confirmationId: "confirmation-1",
    staffMemberId: "cleaner-1",
    state: "WAITING_FOR_CLEANER",
    reason: "CLEANING_NFC_DISABLED",
    occurredAt: new Date("2026-07-24T12:30:00.000Z"),
  });

  const supersededIssue = getOnlyIssue(harness.issues);

  assert.equal(supersededIssue.id, waitingIssue.id);
  assert.equal(
    supersededIssue.issueCode,
    "CLEANING_COVERAGE_SUPERSEDED"
  );
  assert.equal(supersededIssue.workflowState, "RESOLVED");
  assert.equal(supersededIssue.resolutionType, "SUPERSEDED");
  assert.equal(supersededIssue.resolvedBy, "PIN_GO");
});

test("does not create an orphan resolution when no coverage workflow exists", async () => {
  const harness = createPrismaHarness();

  const result =
    await synchronizeCleaningCoverageOperationalIssue({
      prisma: harness.prisma,
      reservationId: "reservation-1",
      confirmationId: "confirmation-1",
      staffMemberId: "cleaner-1",
      state: "CONFIRMED",
      occurredAt: new Date("2026-07-24T12:00:00.000Z"),
    });

  assert.deepEqual(result, {
    applied: false,
    reason: "OPERATIONAL_ISSUE_NOT_FOUND",
  });
  assert.equal(harness.issues.size, 0);
  assert.equal(harness.transitions.length, 0);
});
