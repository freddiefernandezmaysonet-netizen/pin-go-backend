import assert from "node:assert/strict";
import test from "node:test";

import {
  projectMissionControlOperationalState,
} from "./mission-control-projection";
import type {
  MissionControlOperationalItem,
} from "./mission-control-types";

function createItem(
  overrides: Partial<MissionControlOperationalItem> = {}
): MissionControlOperationalItem {
  return {
    issueCode: "TEST_ISSUE",
    title: "Test issue",
    issue: "A test operational issue occurred.",
    operationalImpact: "Operational impact",
    recommendedAction: "Review the issue.",
    nextAutomaticStep: null,
    engine: "OPERATIONS",
    severity: "WARNING",
    workflowState: "WAITING",
    visibility: "HOST",
    responsibleActor: "PIN_GO",
    actionRequired: false,
    canAutoResolve: true,
    autoResolveStatus: "AVAILABLE",
    reservationId: null,
    reservationNumber: null,
    guestName: null,
    cleanerName: null,
    firstDetectedAt: new Date("2026-08-01T12:00:00.000Z"),
    lastSignalAt: new Date("2026-08-01T12:05:00.000Z"),
    resolvedAt: null,
    resolutionCode: null,
    resolutionSummary: null,
    resolutionType: null,
    resolvedBy: null,
    actionTarget: "PROPERTY",
    openUrl: null,
    secondaryActionUrl: null,
    ...overrides,
  };
}

test("projects every workflow state into its canonical Mission Control view", () => {
  const actionRequired = createItem({
    issueCode: "ACTION_REQUIRED",
    workflowState: "ACTION_REQUIRED",
    actionRequired: true,
    visibility: "HOST",
    responsibleActor: "HOST",
  });

  const waiting = createItem({
    issueCode: "WAITING",
    workflowState: "WAITING",
  });

  const autoResolving = createItem({
    issueCode: "AUTO_RESOLVING",
    workflowState: "AUTO_RESOLVING",
    autoResolveStatus: "RUNNING",
  });

  const resolved = createItem({
    issueCode: "RESOLVED",
    workflowState: "RESOLVED",
    resolvedAt: new Date("2026-08-01T12:10:00.000Z"),
    resolutionCode: "TEST_RESOLVED",
    resolutionSummary: "Resolved automatically.",
    resolutionType: "AUTOMATIC",
    resolvedBy: "PIN_GO",
  });

  const projection = projectMissionControlOperationalState([
    actionRequired,
    waiting,
    autoResolving,
    resolved,
  ]);

  assert.deepEqual(projection.currentOperationalState, [
    actionRequired,
    waiting,
    autoResolving,
  ]);

  assert.deepEqual(projection.hostActionQueue, [
    actionRequired,
  ]);

  assert.deepEqual(projection.waitingItems, [
    waiting,
  ]);

  assert.deepEqual(projection.autoResolvingItems, [
    autoResolving,
  ]);

  assert.deepEqual(projection.recentlyResolved, [
    resolved,
  ]);
});

test("excludes non-host and non-actionable issues from the host action queue", () => {
  const hostAction = createItem({
    issueCode: "HOST_ACTION",
    workflowState: "ACTION_REQUIRED",
    visibility: "HOST",
    actionRequired: true,
    responsibleActor: "HOST",
  });

  const systemAction = createItem({
    issueCode: "SYSTEM_ACTION",
    workflowState: "ACTION_REQUIRED",
    visibility: "SYSTEM",
    actionRequired: true,
  });

  const developerAction = createItem({
    issueCode: "DEVELOPER_ACTION",
    workflowState: "ACTION_REQUIRED",
    visibility: "DEVELOPER",
    actionRequired: true,
  });

  const nonActionableHostIssue = createItem({
    issueCode: "HOST_NON_ACTIONABLE",
    workflowState: "ACTION_REQUIRED",
    visibility: "HOST",
    actionRequired: false,
  });

  const projection = projectMissionControlOperationalState([
    hostAction,
    systemAction,
    developerAction,
    nonActionableHostIssue,
  ]);

  assert.deepEqual(projection.hostActionQueue, [
    hostAction,
  ]);
});

test("does not mutate the supplied operational items or their order", () => {
  const items = [
    createItem({
      issueCode: "WAITING_FIRST",
      workflowState: "WAITING",
    }),
    createItem({
      issueCode: "RESOLVED_SECOND",
      workflowState: "RESOLVED",
      resolvedAt: new Date("2026-08-01T12:10:00.000Z"),
    }),
    createItem({
      issueCode: "AUTO_RESOLVING_THIRD",
      workflowState: "AUTO_RESOLVING",
    }),
  ];

  const originalOrder = items.map((item) => item.issueCode);

  projectMissionControlOperationalState(items);

  assert.deepEqual(
    items.map((item) => item.issueCode),
    originalOrder
  );
});