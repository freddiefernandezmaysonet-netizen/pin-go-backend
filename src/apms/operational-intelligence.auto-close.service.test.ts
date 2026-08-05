import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveOperationalIssuesForReservation,
} from "./operational-intelligence.service";

type ResolveClient = Parameters<
  typeof resolveOperationalIssuesForReservation
>[0];

test("auto-closes every active reservation issue and preserves resolution history", async () => {
  const activeIssues = [
    {
      id: "issue-action",
      operationalKey: "ACCESS:reservation-1",
      issueCode: "ACCESS_FAILED",
      workflowState: "ACTION_REQUIRED",
      firstDetectedAt:
        new Date("2026-08-05T20:00:00.000Z"),
    },
    {
      id: "issue-waiting",
      operationalKey: "CLEANING:reservation-1",
      issueCode: "CLEANER_CONFIRMATION_PENDING",
      workflowState: "WAITING",
      firstDetectedAt:
        new Date("2026-08-05T20:01:00.000Z"),
    },
    {
      id: "issue-recovering",
      operationalKey: "DISTRIBUTION:reservation-1",
      issueCode: "OTA_SYNC_RETRYING",
      workflowState: "AUTO_RESOLVING",
      firstDetectedAt:
        new Date("2026-08-05T20:02:00.000Z"),
    },
  ] as const;

  const capturedFindManyArgs: unknown[] = [];
  const capturedUpdates: any[] = [];
  const capturedTransitions: any[] = [];

  const transaction = {
    operationalIssue: {
      async findMany(args: unknown) {
        capturedFindManyArgs.push(args);
        return activeIssues;
      },

      async updateMany(args: any) {
        capturedUpdates.push(args);
        return { count: 1 };
      },
    },

    operationalIssueTransition: {
      async create(args: any) {
        capturedTransitions.push(args);
        return {
          id:
            `transition-${capturedTransitions.length}`,
        };
      },
    },
  };

  const prisma = {
    async $transaction<T>(
      callback: (
        transactionClient:
          typeof transaction
      ) => Promise<T>
    ) {
      return callback(transaction);
    },
  } as unknown as ResolveClient;

  const occurredAt =
    new Date("2026-08-05T21:00:00.000Z");

  const result =
    await resolveOperationalIssuesForReservation(
      prisma,
      {
        reservationId: "reservation-1",
        resolutionCode:
          "RESERVATION_CANCELLED",
        resolutionSummary:
          "The reservation was cancelled.",
        resolutionType: "SUPERSEDED",
        resolvedBy: "GUEST",
        sourceType: "ENGINE_EVENT",
        decisionId:
          "guest-cancellation:reservation-1",
        occurredAt,
      }
    );

  assert.deepEqual(
    capturedFindManyArgs,
    [
      {
        where: {
          reservationId: "reservation-1",
          workflowState: {
            not: "RESOLVED",
          },
        },
        orderBy: {
          firstDetectedAt: "asc",
        },
      },
    ]
  );

  assert.equal(result.resolvedCount, 3);

  assert.deepEqual(
    result.resolvedIssueIds,
    [
      "issue-action",
      "issue-waiting",
      "issue-recovering",
    ]
  );

  assert.equal(capturedUpdates.length, 3);

  for (const update of capturedUpdates) {
    assert.deepEqual(
      update.where.workflowState,
      {
        not: "RESOLVED",
      }
    );

    assert.equal(
      update.data.workflowState,
      "RESOLVED"
    );

    assert.equal(
      update.data.actionRequired,
      false
    );

    assert.equal(
      update.data.recommendedAction,
      null
    );

    assert.equal(
      update.data.nextAutomaticStep,
      null
    );

    assert.equal(
      update.data.resolvedAt,
      occurredAt
    );

    assert.equal(
      update.data.resolutionCode,
      "RESERVATION_CANCELLED"
    );

    assert.equal(
      update.data.resolutionType,
      "SUPERSEDED"
    );

    assert.equal(
      update.data.resolvedBy,
      "GUEST"
    );
  }

  assert.equal(
    capturedTransitions.length,
    3
  );

  assert.deepEqual(
    capturedTransitions.map(
      (transition) => ({
        issueId:
          transition.data.issueId,
        fromWorkflowState:
          transition.data.fromWorkflowState,
        toWorkflowState:
          transition.data.toWorkflowState,
      })
    ),
    [
      {
        issueId: "issue-action",
        fromWorkflowState:
          "ACTION_REQUIRED",
        toWorkflowState: "RESOLVED",
      },
      {
        issueId: "issue-waiting",
        fromWorkflowState: "WAITING",
        toWorkflowState: "RESOLVED",
      },
      {
        issueId: "issue-recovering",
        fromWorkflowState:
          "AUTO_RESOLVING",
        toWorkflowState: "RESOLVED",
      },
    ]
  );
});