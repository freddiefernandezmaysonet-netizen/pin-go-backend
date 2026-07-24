import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import {
  recordCommunicationDeliveryFailure,
  resolveCommunicationDeliveryIssue,
} from "../communications-operational.service";

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
    reservationNumber: "PG-3001",
    guestName: "Message Guest",
    status: "ACTIVE",
    checkOut: new Date(
      "2026-07-27T11:00:00.000Z"
    ),
    propertyId: "property-1",
    property: {
      name: "Ocean Villa",
      organizationId: "org-1",
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
    reservation: {
      findUnique: async (args: any) =>
        args.where.id === reservation.id
          ? reservation
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
    reservation,
  };
}

function context(
  prisma: PrismaClient
) {
  return {
    prisma,
    messageId: "message-1",
    channel: "sms" as const,
    messageType: "SMS",
    reservationId: "reservation-1",
    propertyId: "property-1",
    organizationId: "org-1",
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

test("keeps a retryable delivery blue and deduplicates repeated retry signals", async () => {
  const harness =
    createPrismaHarness();
  const nextAttemptAt = new Date(
    "2026-07-24T12:00:30.000Z"
  );

  await recordCommunicationDeliveryFailure({
    ...context(harness.prisma),
    retryCount: 1,
    maxRetries: 3,
    error:
      "Twilio temporarily unavailable",
    failureKind: "RETRYABLE",
    nextAttemptAt,
    occurredAt: new Date(
      "2026-07-24T12:00:00.000Z"
    ),
  });

  const firstIssue = getOnlyIssue(
    harness.issues
  );

  assert.equal(
    firstIssue.operationalKey,
    "COMMUNICATION_DELIVERY:message-1"
  );
  assert.equal(
    firstIssue.issueCode,
    "COMMUNICATION_SMS_RETRY_SCHEDULED"
  );
  assert.equal(
    firstIssue.engine,
    "COMMUNICATIONS"
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
    firstIssue.metadata.attempt,
    1
  );
  assert.equal(
    firstIssue.metadata.maxAttempts,
    3
  );
  assert.equal(
    firstIssue.metadata.nextAttemptAt,
    nextAttemptAt.toISOString()
  );
  assert.equal(
    firstIssue.metadata.exhausted,
    false
  );
  assert.equal(
    harness.transitions.length,
    1
  );

  await recordCommunicationDeliveryFailure({
    ...context(harness.prisma),
    retryCount: 2,
    maxRetries: 3,
    error:
      "Twilio still unavailable",
    failureKind: "RETRYABLE",
    nextAttemptAt: new Date(
      "2026-07-24T12:01:00.000Z"
    ),
    occurredAt: new Date(
      "2026-07-24T12:00:30.000Z"
    ),
  });

  const secondIssue = getOnlyIssue(
    harness.issues
  );

  assert.equal(secondIssue.id, firstIssue.id);
  assert.equal(
    secondIssue.metadata.attempt,
    2
  );
  assert.equal(
    harness.transitions.length,
    1
  );
});

test("moves the same delivery from blue to red after the retry budget is exhausted", async () => {
  const harness =
    createPrismaHarness();

  await recordCommunicationDeliveryFailure({
    ...context(harness.prisma),
    retryCount: 2,
    maxRetries: 3,
    error: "Temporary provider failure",
    failureKind: "RETRYABLE",
    nextAttemptAt: new Date(
      "2026-07-24T12:01:00.000Z"
    ),
    occurredAt: new Date(
      "2026-07-24T12:00:30.000Z"
    ),
  });

  const blueIssue = getOnlyIssue(
    harness.issues
  );

  await recordCommunicationDeliveryFailure({
    ...context(harness.prisma),
    retryCount: 3,
    maxRetries: 3,
    error:
      "Provider unavailable after final retry",
    failureKind:
      "RETRY_BUDGET_EXHAUSTED",
    nextAttemptAt: null,
    occurredAt: new Date(
      "2026-07-24T12:01:00.000Z"
    ),
  });

  const redIssue = getOnlyIssue(
    harness.issues
  );

  assert.equal(redIssue.id, blueIssue.id);
  assert.equal(
    redIssue.issueCode,
    "COMMUNICATION_SMS_RETRY_EXHAUSTED"
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
    redIssue.metadata.attempt,
    3
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

test("resolves the same delivery after an automatic retry succeeds", async () => {
  const harness =
    createPrismaHarness();

  await recordCommunicationDeliveryFailure({
    ...context(harness.prisma),
    retryCount: 1,
    maxRetries: 3,
    error: "Temporary provider failure",
    failureKind: "RETRYABLE",
    nextAttemptAt: new Date(
      "2026-07-24T12:00:30.000Z"
    ),
    occurredAt: new Date(
      "2026-07-24T12:00:00.000Z"
    ),
  });

  const waitingIssue = getOnlyIssue(
    harness.issues
  );

  await resolveCommunicationDeliveryIssue({
    ...context(harness.prisma),
    retryCount: 2,
    occurredAt: new Date(
      "2026-07-24T12:00:20.000Z"
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
    "COMMUNICATION_DELIVERY_RECOVERED"
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
  assert.equal(
    harness.transitions.length,
    2
  );
});

test("does not create red noise for a cancelled reservation and supersedes an existing retry", async () => {
  const harness =
    createPrismaHarness();

  harness.reservation.status =
    "CANCELLED";

  const noExistingIssueResult =
    await recordCommunicationDeliveryFailure({
      ...context(harness.prisma),
      retryCount: 3,
      maxRetries: 3,
      error: "Provider unavailable",
      failureKind:
        "RETRY_BUDGET_EXHAUSTED",
      occurredAt: new Date(
        "2026-07-24T12:00:00.000Z"
      ),
    });

  assert.equal(
    noExistingIssueResult.applied,
    false
  );
  assert.equal(harness.issues.size, 0);

  harness.reservation.status = "ACTIVE";

  await recordCommunicationDeliveryFailure({
    ...context(harness.prisma),
    retryCount: 1,
    maxRetries: 3,
    error: "Temporary provider failure",
    failureKind: "RETRYABLE",
    nextAttemptAt: new Date(
      "2026-07-24T12:00:30.000Z"
    ),
    occurredAt: new Date(
      "2026-07-24T12:00:00.000Z"
    ),
  });

  const waitingIssue = getOnlyIssue(
    harness.issues
  );

  harness.reservation.status =
    "CANCELLED";

  await recordCommunicationDeliveryFailure({
    ...context(harness.prisma),
    retryCount: 2,
    maxRetries: 3,
    error: "Provider unavailable",
    failureKind: "RETRYABLE",
    nextAttemptAt: new Date(
      "2026-07-24T12:01:00.000Z"
    ),
    occurredAt: new Date(
      "2026-07-24T12:00:30.000Z"
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
    "COMMUNICATION_DELIVERY_SUPERSEDED"
  );
  assert.equal(
    supersededIssue.workflowState,
    "RESOLVED"
  );
  assert.equal(
    supersededIssue.resolutionType,
    "SUPERSEDED"
  );
  assert.equal(
    supersededIssue.actionRequired,
    false
  );
});
