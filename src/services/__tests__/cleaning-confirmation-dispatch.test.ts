import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import {
  processPendingCleaningConfirmations,
} from "../cleaning-confirmation-dispatch.service";

type StoredIssue = Record<string, any> & {
  id: string;
  operationalKey: string;
};

function createPrismaHarness(
  now: Date,
  options: {
    recentFailedSms?: boolean;
  } = {}
) {
  const issues = new Map<string, StoredIssue>();
  const transitions: Array<Record<string, any>> = [];
  const failedAt = new Date(
    now.getTime() - 5 * 60_000
  );

  const confirmation = {
    id: "confirmation-1",
    reservationId: "reservation-1",
    propertyId: "property-1",
    staffMemberId: "cleaner-1",
    token: "cleaning-token-1",
    status: "PENDING",
    createdAt: new Date(
      now.getTime() - 30 * 60_000
    ),
  };

  const reservation = {
    id: "reservation-1",
    reservationNumber: "PG-5001",
    guestName: "Dispatch Guest",
    status: "ACTIVE",
    checkOut: new Date(
      now.getTime() + 24 * 60 * 60_000
    ),
    roomName: "Suite 1",
    propertyId: "property-1",
    property: {
      id: "property-1",
      name: "Ocean Villa",
      organizationId: "org-1",
      timezone: "America/Puerto_Rico",
      cleaningNfcEnabled: true,
    },
  };

  const transaction = {
    operationalIssue: {
      findUnique: async (args: any) =>
        issues.get(
          String(args.where.operationalKey)
        ) ?? null,
      upsert: async (args: any) => {
        const operationalKey = String(
          args.where.operationalKey
        );
        const current =
          issues.get(operationalKey) ?? null;
        const stored = {
          id: current?.id ?? "issue-1",
          ...(current ?? {}),
          ...(current
            ? args.update
            : args.create),
        };

        issues.set(operationalKey, stored);
        return stored;
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
    cleaningConfirmation: {
      findMany: async () => [confirmation],
      findFirst: async (args: any) => {
        if (args.where.status === "CONFIRMED") {
          return null;
        }

        return null;
      },
    },
    property: {
      findUnique: async () => ({
        cleaningNfcEnabled: true,
      }),
    },
    reservation: {
      findUnique: async () => reservation,
    },
    staffMember: {
      findUnique: async () => ({
        id: "cleaner-1",
        fullName: "Cleaner One",
        phoneE164: "+17875550123",
      }),
    },
    messageLog: {
      findFirst: async () => null,
    },
    messageDispatchLog: {
      findFirst: async () =>
        options.recentFailedSms === false
          ? null
          : {
              id: "dispatch-failed-1",
              createdAt: failedAt,
            },
    },
    operationalIssue: {
      findUnique: async (args: any) =>
        issues.get(
          String(args.where.operationalKey)
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
    failedAt,
  };
}

function getOnlyIssue(
  issues: Map<string, StoredIssue>
) {
  assert.equal(issues.size, 1);
  const issue = Array.from(issues.values())[0];
  assert.ok(issue);
  return issue;
}

test("keeps a recent failed cleaner SMS under Pin&Go retry ownership", async () => {
  const now = new Date(
    "2026-08-02T16:00:00.000Z"
  );
  const harness = createPrismaHarness(now);

  const result =
    await processPendingCleaningConfirmations(
      harness.prisma,
      now
    );

  assert.deepEqual(result, {
    processed: 1,
    sent: 0,
    skipped: 1,
    fallbackCreated: 0,
    expired: 0,
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
    "CLEANING_CONFIRMATION_DISPATCH_RETRY_SCHEDULED"
  );
  assert.equal(issue.workflowState, "WAITING");
  assert.equal(
    issue.responsibleActor,
    "PIN_GO"
  );
  assert.equal(issue.actionRequired, false);
  assert.equal(
    issue.autoResolveActionCode,
    "RETRY_CLEANER_NOTIFICATION"
  );
  assert.equal(
    issue.metadata.nextAttemptAt,
    new Date(
      harness.failedAt.getTime() +
        15 * 60_000
    ).toISOString()
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

test("keeps cleaner dispatch under Pin&Go ownership outside allowed hours", async () => {
  const now = new Date(
    "2026-08-02T07:00:00.000Z"
  );
  const harness = createPrismaHarness(now, {
    recentFailedSms: false,
  });

  const result =
    await processPendingCleaningConfirmations(
      harness.prisma,
      now
    );

  assert.deepEqual(result, {
    processed: 1,
    sent: 0,
    skipped: 1,
    fallbackCreated: 0,
    expired: 0,
  });

  const issue = getOnlyIssue(
    harness.issues
  );

  assert.equal(
    issue.issueCode,
    "CLEANING_CONFIRMATION_DISPATCH_RETRY_SCHEDULED"
  );
  assert.equal(issue.workflowState, "WAITING");
  assert.equal(
    issue.responsibleActor,
    "PIN_GO"
  );
  assert.equal(issue.actionRequired, false);
  assert.equal(
    issue.autoResolveActionCode,
    "RETRY_CLEANER_NOTIFICATION"
  );
  assert.equal(
    issue.metadata.reason,
    "OUTSIDE_ALLOWED_HOURS"
  );
  assert.equal(
    issue.metadata.nextAttemptAt,
    null
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
