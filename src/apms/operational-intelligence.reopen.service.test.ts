import assert from "node:assert/strict";
import test from "node:test";

import {
  APMS_OPERATIONAL_ISSUE_NOT_FOUND,
  APMS_OPERATIONAL_REOPEN_SOURCE_NOT_RESOLVED,
  ApmsOperationalIssueNotFoundError,
  ApmsOperationalReopenSourceNotResolvedError,
  reopenOperationalIssue,
} from "./operational-intelligence.service.js";
import type { ReopenOperationalIssueInput } from "./operational-intelligence.service.js";

const OCCURRED_AT = new Date("2026-08-04T15:30:00.000Z");

const reopenInput: ReopenOperationalIssueInput = {
  operationalKey: "reservation:res_123:guest-access",
  workflowState: "AUTO_RESOLVING",
  severity: "WARNING",
  responsibleActor: "PIN_GO",
  actionRequired: false,
  recommendedAction: null,
  nextAutomaticStep: "Retry guest access credential delivery.",
  canAutoResolve: true,
  autoResolveStatus: "RUNNING",
  autoResolveActionCode: "RETRY_GUEST_ACCESS_DELIVERY",
  reopenCode: "GUEST_ACCESS_FAILURE_RECURRED",
  reopenSummary: "Guest access failed again after resolution.",
  reopenedBy: "PIN_GO",
  sourceType: "ENGINE_EVENT",
  decisionId: "decision_reopen_123",
  sourceAuditEntryId: "audit_reopen_123",
  occurredAt: OCCURRED_AT,
  metadata: {
    reservationId: "res_123",
    attempt: 2,
  },
};

const resolvedIssue = {
  id: "issue_123",
  operationalKey: reopenInput.operationalKey,
  issueCode: "GUEST_ACCESS_FAILED",
  workflowState: "RESOLVED",
  reopenedCount: 1,
};

const reopenedIssue = {
  ...resolvedIssue,
  workflowState: "AUTO_RESOLVING",
  reopenedCount: 2,
  resolvedAt: null,
  resolutionCode: null,
  resolutionSummary: null,
  resolutionType: null,
  resolvedBy: null,
};

type ReopenClient = Parameters<typeof reopenOperationalIssue>[0];

test("reopens a resolved operational issue atomically and records its transition", async () => {
  let findUniqueCalls = 0;
  let updateManyCalls = 0;
  let transitionCreateCalls = 0;

  const transaction = {
    operationalIssue: {
      async findUnique(args: unknown) {
        findUniqueCalls += 1;
        assert.deepEqual(args, {
          where: { operationalKey: reopenInput.operationalKey },
        });
        return findUniqueCalls === 1 ? resolvedIssue : reopenedIssue;
      },
      async updateMany(args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) {
        updateManyCalls += 1;
        assert.deepEqual(args.where, {
          id: resolvedIssue.id,
          workflowState: "RESOLVED",
        });
        assert.equal(args.data.workflowState, "AUTO_RESOLVING");
        assert.equal(args.data.severity, "WARNING");
        assert.equal(args.data.responsibleActor, "PIN_GO");
        assert.equal(args.data.actionRequired, false);
        assert.equal(args.data.canAutoResolve, true);
        assert.equal(args.data.autoResolveStatus, "RUNNING");
        assert.deepEqual(args.data.reopenedCount, { increment: 1 });
        assert.equal(args.data.resolvedAt, null);
        assert.equal(args.data.resolutionCode, null);
        assert.equal(args.data.resolutionSummary, null);
        assert.equal(args.data.resolutionType, null);
        assert.equal(args.data.resolvedBy, null);
        assert.equal(args.data.lastSignalAt, OCCURRED_AT);
        assert.equal(args.data.decisionId, "decision_reopen_123");
        assert.equal(args.data.sourceAuditEntryId, "audit_reopen_123");
        assert.equal(args.data.sourceType, "ENGINE_EVENT");
        return { count: 1 };
      },
    },
    operationalIssueTransition: {
      async create(args: { data: Record<string, unknown> }) {
        transitionCreateCalls += 1;
        assert.equal(args.data.issueId, resolvedIssue.id);
        assert.equal(args.data.operationalKey, reopenInput.operationalKey);
        assert.equal(args.data.issueCode, resolvedIssue.issueCode);
        assert.equal(args.data.fromWorkflowState, "RESOLVED");
        assert.equal(args.data.toWorkflowState, "AUTO_RESOLVING");
        assert.equal(args.data.transitionCode, reopenInput.reopenCode);
        assert.equal(args.data.transitionSummary, reopenInput.reopenSummary);
        assert.equal(args.data.transitionedBy, "PIN_GO");
        assert.equal(args.data.occurredAt, OCCURRED_AT);
        return { id: "transition_123" };
      },
    },
  };

  const prisma = {
    async $transaction<T>(callback: (client: typeof transaction) => Promise<T>) {
      return callback(transaction);
    },
  } as unknown as ReopenClient;

  const result = await reopenOperationalIssue(prisma, reopenInput);

  assert.equal(result, reopenedIssue);
  assert.equal(findUniqueCalls, 2);
  assert.equal(updateManyCalls, 1);
  assert.equal(transitionCreateCalls, 1);
});

test("rejects reopening when the operational issue does not exist", async () => {
  const transaction = {
    operationalIssue: {
      async findUnique() {
        return null;
      },
      async updateMany() {
        assert.fail("Missing operational issues must not be updated");
      },
    },
    operationalIssueTransition: {
      async create() {
        assert.fail("Missing operational issues must not create transitions");
      },
    },
  };

  const prisma = {
    async $transaction<T>(callback: (client: typeof transaction) => Promise<T>) {
      return callback(transaction);
    },
  } as unknown as ReopenClient;

  await assert.rejects(
    () => reopenOperationalIssue(prisma, reopenInput),
    (error: unknown) => {
      assert.ok(error instanceof ApmsOperationalIssueNotFoundError);
      assert.equal(error.code, APMS_OPERATIONAL_ISSUE_NOT_FOUND);
      assert.equal(error.operationalKey, reopenInput.operationalKey);
      return true;
    }
  );
});

test("rejects reopening when the current issue is not resolved", async () => {
  const transaction = {
    operationalIssue: {
      async findUnique() {
        return {
          ...resolvedIssue,
          workflowState: "WAITING",
        };
      },
      async updateMany() {
        assert.fail("Active operational issues must not be reopened");
      },
    },
    operationalIssueTransition: {
      async create() {
        assert.fail("Active operational issues must not create reopen transitions");
      },
    },
  };

  const prisma = {
    async $transaction<T>(callback: (client: typeof transaction) => Promise<T>) {
      return callback(transaction);
    },
  } as unknown as ReopenClient;

  await assert.rejects(
    () => reopenOperationalIssue(prisma, reopenInput),
    (error: unknown) => {
      assert.ok(
        error instanceof ApmsOperationalReopenSourceNotResolvedError
      );
      assert.equal(
        error.code,
        APMS_OPERATIONAL_REOPEN_SOURCE_NOT_RESOLVED
      );
      assert.equal(error.operationalKey, reopenInput.operationalKey);
      assert.equal(error.workflowState, "WAITING");
      return true;
    }
  );
});

test("rejects a lost concurrent reopen without creating a transition", async () => {
  let findUniqueCalls = 0;
  let transitionCreateCalls = 0;

  const transaction = {
    operationalIssue: {
      async findUnique() {
        findUniqueCalls += 1;
        if (findUniqueCalls === 1) return resolvedIssue;
        return {
          ...resolvedIssue,
          workflowState: "AUTO_RESOLVING",
        };
      },
      async updateMany() {
        return { count: 0 };
      },
    },
    operationalIssueTransition: {
      async create() {
        transitionCreateCalls += 1;
        assert.fail("Lost concurrent reopen must not create a transition");
      },
    },
  };

  const prisma = {
    async $transaction<T>(callback: (client: typeof transaction) => Promise<T>) {
      return callback(transaction);
    },
  } as unknown as ReopenClient;

  await assert.rejects(
    () => reopenOperationalIssue(prisma, reopenInput),
    (error: unknown) => {
      assert.ok(
        error instanceof ApmsOperationalReopenSourceNotResolvedError
      );
      assert.equal(error.workflowState, "AUTO_RESOLVING");
      return true;
    }
  );

  assert.equal(findUniqueCalls, 2);
  assert.equal(transitionCreateCalls, 0);
});
