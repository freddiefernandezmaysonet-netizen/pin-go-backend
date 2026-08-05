import assert from "node:assert/strict";
import test from "node:test";

import {
  upsertOperationalIssue,
} from "./operational-intelligence.service";
import type {
  UpsertOperationalIssueInput,
} from "./operational-intelligence.service";

const operationalInput: UpsertOperationalIssueInput = {
  operationalKey:
    "TEST_OPERATIONAL_DEDUPLICATION:entity-1",
  issueCode:
    "TEST_OPERATIONAL_RECOVERING",

  title:
    "Pin&Go is recovering automatically",
  issue:
    "A repeated operational signal was detected.",
  operationalImpact:
    "The workflow is still under automatic recovery.",
  recommendedAction:
    "No host action is required yet.",
  nextAutomaticStep:
    "Pin&Go will retry automatically.",

  engine: "MISSION_CONTROL",

  severity: "WARNING",
  workflowState: "AUTO_RESOLVING",
  visibility: "HOST",
  responsibleActor: "PIN_GO",

  actionRequired: false,

  canAutoResolve: true,
  autoResolveStatus: "RUNNING",
  autoResolveActionCode:
    "TEST_AUTOMATIC_RECOVERY",

  organizationId: "organization-1",
  propertyId: "property-1",
  reservationId: null,

  guestName: null,
  staffMemberId: null,
  cleanerName: null,

  decisionId: null,
  sourceAuditEntryId: null,
  sourceType: "ENGINE_EVENT",

  resolvedAt: null,
  resolutionCode: null,
  resolutionSummary: null,
  resolutionType: null,
  resolvedBy: null,

  actionTarget: "SYSTEM",

  metadata: {
    entityId: "entity-1",
  },

  transitionCode:
    "TEST_OPERATIONAL_RECOVERING",
  transitionSummary:
    "Pin&Go started automatic recovery.",
  transitionedBy: "PIN_GO",

  occurredAt:
    new Date("2026-08-05T21:30:00.000Z"),
  lastSignalAt:
    new Date("2026-08-05T21:30:00.000Z"),
};

type UpsertClient = Parameters<
  typeof upsertOperationalIssue
>[0];

test("deduplicates the same concurrent operational transition", async () => {
  let persistedIssue:
    | {
        id: string;
        operationalKey: string;
        workflowState: "AUTO_RESOLVING";
        issueCode: string;
      }
    | null = null;

  let transitionCreateCount = 0;

  let releaseInitialReads:
    | (() => void)
    | null = null;

  const initialReadsReleased = new Promise<void>(
    (resolve) => {
      releaseInitialReads = resolve;
    }
  );

  let initialReadCount = 0;

  let lockTail = Promise.resolve();

  function createTransaction() {
    let releaseLock: (() => void) | null =
      null;

    return {
      async $executeRawUnsafe(
        query: string,
        operationalKey: string
      ) {
        assert.equal(
          query,
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))"
        );

        assert.equal(
          operationalKey,
          operationalInput.operationalKey
        );

        const previousLock = lockTail;

        lockTail = new Promise<void>(
          (resolve) => {
            releaseLock = resolve;
          }
        );

        await previousLock;
      },

      releaseLock() {
        releaseLock?.();
      },

      operationalIssue: {
        async findUnique() {
          return persistedIssue;
        },

        async upsert() {
          persistedIssue ??= {
            id: "issue-1",
            operationalKey:
              operationalInput.operationalKey,
            workflowState: "AUTO_RESOLVING",
            issueCode:
              operationalInput.issueCode,
          };

          return persistedIssue;
        },
      },

      operationalIssueTransition: {
        async create() {
          transitionCreateCount += 1;

          return {
            id:
              `transition-${transitionCreateCount}`,
          };
        },
      },
    };
  }
  const prisma = {
    async $transaction<T>(
      callback: (
        transaction: ReturnType<
          typeof createTransaction
        >
      ) => Promise<T>
    ) {
      const transaction =
        createTransaction();

      try {
        return await callback(transaction);
      } finally {
        transaction.releaseLock();
      }
    },
  } as unknown as UpsertClient;

  await Promise.all([
    upsertOperationalIssue(
      prisma,
      operationalInput
    ),
    upsertOperationalIssue(
      prisma,
      operationalInput
    ),
  ]);

  assert.equal(
    persistedIssue?.operationalKey,
    operationalInput.operationalKey
  );

  assert.equal(
    transitionCreateCount,
    1,
    "Concurrent identical signals must create one historical transition."
  );
});