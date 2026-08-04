import assert from "node:assert/strict";
import test from "node:test";

import {
  APMS_OPERATIONAL_ISSUE_NOT_FOUND,
  APMS_OPERATIONAL_REOPEN_SOURCE_NOT_RESOLVED,
  APMS_OPERATIONAL_REOPEN_TARGET_INVALID,
  ApmsOperationalIssueNotFoundError,
  ApmsOperationalReopenSourceNotResolvedError,
  ApmsOperationalReopenTargetInvalidError,
} from "./operational-intelligence.service.js";
import type { ReopenOperationalIssueInput } from "./operational-intelligence.service.js";

const reopenInput = {
  operationalKey: "reservation:res_123:guest-access",
  workflowState: "AUTO_RESOLVING",
  reopenCode: "GUEST_ACCESS_FAILURE_RECURRED",
  reopenSummary: "Guest access failed again after the issue was resolved.",
  reopenedBy: "ACCESS_ENGINE",
  sourceType: "ENGINE",
  decisionId: "decision_reopen_123",
  sourceAuditEntryId: "audit_reopen_123",
  occurredAt: new Date("2026-08-04T14:30:00.000Z"),
  metadata: {
    reservationId: "res_123",
    attempt: 2,
  },
} satisfies ReopenOperationalIssueInput;

const invalidResolvedTarget = {
  ...reopenInput,
  workflowState: "RESOLVED",
};

// @ts-expect-error RESOLVED is not a valid explicit reopen target.
const rejectedResolvedTarget: ReopenOperationalIssueInput =
  invalidResolvedTarget;

void rejectedResolvedTarget;

test("accepts the complete explicit reopen contract", () => {
  assert.equal(
    reopenInput.operationalKey,
    "reservation:res_123:guest-access"
  );
  assert.equal(reopenInput.workflowState, "AUTO_RESOLVING");
  assert.equal(
    reopenInput.reopenCode,
    "GUEST_ACCESS_FAILURE_RECURRED"
  );
  assert.equal(reopenInput.reopenedBy, "ACCESS_ENGINE");
  assert.equal(reopenInput.sourceType, "ENGINE");
  assert.equal(reopenInput.metadata.attempt, 2);
});

test("constructs the canonical operational issue not found error", () => {
  const error = new ApmsOperationalIssueNotFoundError(
    "reservation:missing:issue"
  );

  assert.equal(error.name, "ApmsOperationalIssueNotFoundError");
  assert.equal(error.code, APMS_OPERATIONAL_ISSUE_NOT_FOUND);
  assert.equal(error.operationalKey, "reservation:missing:issue");
  assert.equal(
    error.message,
    "APMS_OPERATIONAL_ISSUE_NOT_FOUND: reservation:missing:issue"
  );
});

test("constructs the canonical reopen source not resolved error", () => {
  const error = new ApmsOperationalReopenSourceNotResolvedError(
    "reservation:res_123:guest-access",
    "WAITING"
  );

  assert.equal(
    error.name,
    "ApmsOperationalReopenSourceNotResolvedError"
  );
  assert.equal(
    error.code,
    APMS_OPERATIONAL_REOPEN_SOURCE_NOT_RESOLVED
  );
  assert.equal(
    error.operationalKey,
    "reservation:res_123:guest-access"
  );
  assert.equal(error.workflowState, "WAITING");
  assert.equal(
    error.message,
    "APMS_OPERATIONAL_REOPEN_SOURCE_NOT_RESOLVED: reservation:res_123:guest-access is WAITING"
  );
});

test("constructs the canonical invalid reopen target error", () => {
  const error = new ApmsOperationalReopenTargetInvalidError(
    "RESOLVED"
  );

  assert.equal(
    error.name,
    "ApmsOperationalReopenTargetInvalidError"
  );
  assert.equal(
    error.code,
    APMS_OPERATIONAL_REOPEN_TARGET_INVALID
  );
  assert.equal(error.workflowState, "RESOLVED");
  assert.equal(
    error.message,
    "APMS_OPERATIONAL_REOPEN_TARGET_INVALID: RESOLVED"
  );
});
