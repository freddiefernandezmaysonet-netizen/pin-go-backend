import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import {
  synchronizeDeviceHealthOperationalIssues,
} from "../device-health-operational.service";

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
    reservation: {
      findFirst: async () => ({
        id: "reservation-1",
        reservationNumber: "PG-2001",
        guestName: "Battery Guest",
        checkIn: new Date(
          "2026-07-24T18:00:00.000Z"
        ),
        checkOut: new Date(
          "2026-07-26T11:00:00.000Z"
        ),
      }),
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

function baseInput(
  prisma: PrismaClient
) {
  return {
    prisma,
    organizationId: "org-1",
    propertyId: "property-1",
    propertyName: "Ocean Villa",
    lockId: "lock-1",
    lockName: "Front Door",
    lockIsActive: true,
    battery: 80,
    batteryLastCheckedAt: new Date(
      "2026-07-24T12:00:00.000Z"
    ),
    batteryLastSuccessfulAt: new Date(
      "2026-07-24T12:00:00.000Z"
    ),
    batteryLastFailedAt: null,
    batteryLastError: null,
    batteryNextCheckAt: new Date(
      "2026-08-23T12:00:00.000Z"
    ),
    occurredAt: new Date(
      "2026-07-24T12:00:00.000Z"
    ),
  };
}

function getIssue(
  issues: Map<string, StoredIssue>,
  operationalKey: string
) {
  const issue = issues.get(operationalKey);
  assert.ok(issue);
  return issue;
}

test("keeps battery telemetry recovery blue while another check is scheduled", async () => {
  const harness =
    createPrismaHarness();

  const nextAttemptAt = new Date(
    "2026-07-24T16:00:00.000Z"
  );

  await synchronizeDeviceHealthOperationalIssues({
    ...baseInput(harness.prisma),
    battery: null,
    batteryLastSuccessfulAt: null,
    batteryLastFailedAt: new Date(
      "2026-07-24T12:00:00.000Z"
    ),
    batteryLastError:
      "TTLock battery request timed out",
    batteryNextCheckAt: nextAttemptAt,
  });

  assert.equal(harness.issues.size, 1);

  const issue = getIssue(
    harness.issues,
    "DEVICE_BATTERY_TELEMETRY:lock-1"
  );

  assert.equal(
    issue.issueCode,
    "DEVICE_BATTERY_TELEMETRY_RETRY_SCHEDULED"
  );
  assert.equal(
    issue.engine,
    "DEVICE_HEALTH"
  );
  assert.equal(
    issue.workflowState,
    "WAITING"
  );
  assert.equal(
    issue.actionRequired,
    false
  );
  assert.equal(
    issue.responsibleActor,
    "PIN_GO"
  );
  assert.equal(
    issue.metadata.nextAttemptAt,
    nextAttemptAt.toISOString()
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

test("creates a host action when a confirmed battery reading is below 30 percent", async () => {
  const harness =
    createPrismaHarness();

  await synchronizeDeviceHealthOperationalIssues({
    ...baseInput(harness.prisma),
    battery: 25,
    batteryNextCheckAt: new Date(
      "2026-07-31T12:00:00.000Z"
    ),
  });

  assert.equal(harness.issues.size, 1);

  const issue = getIssue(
    harness.issues,
    "DEVICE_BATTERY_LEVEL:lock-1"
  );

  assert.equal(
    issue.issueCode,
    "DEVICE_BATTERY_REPLACEMENT_REQUIRED"
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
  assert.equal(
    issue.canAutoResolve,
    false
  );
  assert.equal(
    issue.metadata.battery,
    25
  );
  assert.equal(
    issue.metadata.lowBatteryThreshold,
    30
  );
  assert.equal(
    issue.metadata.reservationNumber,
    "PG-2001"
  );
});

test("does not resolve low battery from an unknown reading and resolves only after a confirmed healthy reading", async () => {
  const harness =
    createPrismaHarness();

  await synchronizeDeviceHealthOperationalIssues({
    ...baseInput(harness.prisma),
    battery: 15,
  });

  const criticalIssue = getIssue(
    harness.issues,
    "DEVICE_BATTERY_LEVEL:lock-1"
  );

  assert.equal(
    criticalIssue.issueCode,
    "DEVICE_BATTERY_REPLACEMENT_CRITICAL"
  );
  assert.equal(
    criticalIssue.workflowState,
    "ACTION_REQUIRED"
  );

  const transitionCountBeforeUnknown =
    harness.transitions.length;

  const unknownResult =
    await synchronizeDeviceHealthOperationalIssues({
      ...baseInput(harness.prisma),
      battery: null,
      batteryLastSuccessfulAt: null,
      occurredAt: new Date(
        "2026-07-24T13:00:00.000Z"
      ),
    });

  assert.equal(
    unknownResult.batteryLevel.applied,
    false
  );
  assert.equal(
    unknownResult.batteryLevel.reason,
    "BATTERY_LEVEL_UNKNOWN"
  );

  const issueAfterUnknown = getIssue(
    harness.issues,
    "DEVICE_BATTERY_LEVEL:lock-1"
  );

  assert.equal(
    issueAfterUnknown.id,
    criticalIssue.id
  );
  assert.equal(
    issueAfterUnknown.workflowState,
    "ACTION_REQUIRED"
  );
  assert.equal(
    harness.transitions.length,
    transitionCountBeforeUnknown
  );

  await synchronizeDeviceHealthOperationalIssues({
    ...baseInput(harness.prisma),
    battery: 85,
    batteryLastCheckedAt: new Date(
      "2026-07-24T14:00:00.000Z"
    ),
    batteryLastSuccessfulAt: new Date(
      "2026-07-24T14:00:00.000Z"
    ),
    occurredAt: new Date(
      "2026-07-24T14:00:00.000Z"
    ),
  });

  const resolvedIssue = getIssue(
    harness.issues,
    "DEVICE_BATTERY_LEVEL:lock-1"
  );

  assert.equal(
    resolvedIssue.id,
    criticalIssue.id
  );
  assert.equal(
    resolvedIssue.issueCode,
    "DEVICE_BATTERY_LEVEL_HEALTHY"
  );
  assert.equal(
    resolvedIssue.workflowState,
    "RESOLVED"
  );
  assert.equal(
    resolvedIssue.resolutionCode,
    "DEVICE_BATTERY_REPLACED"
  );
  assert.equal(
    resolvedIssue.resolvedBy,
    "PIN_GO"
  );
});
