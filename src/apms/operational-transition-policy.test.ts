import assert from "node:assert/strict";
import test from "node:test";

import type { OperationalWorkflowState } from "./operational-intelligence-types.js";
import {
  APMS_OPERATIONAL_REOPEN_REQUIRED,
  ApmsOperationalReopenRequiredError,
  isActiveOperationalWorkflowState,
  isOperationalReopen,
  isOperationalTransitionAllowed,
  requireOperationalTransition,
} from "./operational-transition-policy.js";

const WORKFLOW_STATES = [
  "WAITING",
  "AUTO_RESOLVING",
  "ACTION_REQUIRED",
  "RESOLVED",
] as const satisfies readonly OperationalWorkflowState[];

const ACTIVE_STATES = [
  "WAITING",
  "AUTO_RESOLVING",
  "ACTION_REQUIRED",
] as const satisfies readonly OperationalWorkflowState[];

test("allows every official state as an initial operational state", () => {
  for (const toWorkflowState of WORKFLOW_STATES) {
    assert.equal(
      isOperationalTransitionAllowed(null, toWorkflowState),
      true
    );
    assert.doesNotThrow(() =>
      requireOperationalTransition(null, toWorkflowState)
    );
  }
});

test("allows the complete active-state transition matrix", () => {
  for (const fromWorkflowState of ACTIVE_STATES) {
    for (const toWorkflowState of WORKFLOW_STATES) {
      assert.equal(
        isOperationalTransitionAllowed(
          fromWorkflowState,
          toWorkflowState
        ),
        true,
        `Expected ${fromWorkflowState} -> ${toWorkflowState} to be allowed`
      );

      assert.doesNotThrow(() =>
        requireOperationalTransition(
          fromWorkflowState,
          toWorkflowState
        )
      );
    }
  }
});

test("treats same-state signals as allowed idempotent transitions", () => {
  for (const workflowState of WORKFLOW_STATES) {
    assert.equal(
      isOperationalTransitionAllowed(
        workflowState,
        workflowState
      ),
      true
    );

    assert.doesNotThrow(() =>
      requireOperationalTransition(
        workflowState,
        workflowState
      )
    );
  }
});

test("identifies only RESOLVED to active-state changes as reopen operations", () => {
  for (const toWorkflowState of ACTIVE_STATES) {
    assert.equal(
      isOperationalReopen("RESOLVED", toWorkflowState),
      true
    );
  }

  assert.equal(
    isOperationalReopen("RESOLVED", "RESOLVED"),
    false
  );

  for (const fromWorkflowState of ACTIVE_STATES) {
    for (const toWorkflowState of WORKFLOW_STATES) {
      assert.equal(
        isOperationalReopen(
          fromWorkflowState,
          toWorkflowState
        ),
        false
      );
    }
  }

  for (const toWorkflowState of WORKFLOW_STATES) {
    assert.equal(
      isOperationalReopen(null, toWorkflowState),
      false
    );
  }
});

test("blocks implicit reopening of resolved operational issues", () => {
  for (const toWorkflowState of ACTIVE_STATES) {
    assert.equal(
      isOperationalTransitionAllowed(
        "RESOLVED",
        toWorkflowState
      ),
      false
    );

    assert.throws(
      () =>
        requireOperationalTransition(
          "RESOLVED",
          toWorkflowState
        ),
      (error: unknown) => {
        assert.ok(
          error instanceof ApmsOperationalReopenRequiredError
        );
        assert.equal(
          error.code,
          APMS_OPERATIONAL_REOPEN_REQUIRED
        );
        assert.equal(error.toWorkflowState, toWorkflowState);
        assert.match(
          error.message,
          new RegExp(
            `RESOLVED -> ${toWorkflowState} requires an explicit reopen operation`
          )
        );
        return true;
      }
    );
  }
});

test("recognizes active and terminal operational workflow states", () => {
  for (const workflowState of ACTIVE_STATES) {
    assert.equal(
      isActiveOperationalWorkflowState(workflowState),
      true
    );
  }

  assert.equal(
    isActiveOperationalWorkflowState("RESOLVED"),
    false
  );
});
