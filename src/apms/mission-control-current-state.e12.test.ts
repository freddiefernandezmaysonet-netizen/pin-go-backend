import assert from "node:assert/strict";
import test from "node:test";

import type { MissionControlOperationalItem } from "./mission-control-types";
import {
  deriveMissionControlCurrentStateSummary,
  projectMissionControlOperationalState,
} from "./mission-control-projection";

function issue(
  overrides: Partial<MissionControlOperationalItem> = {}
): MissionControlOperationalItem {
  return {
    issueCode: "GUEST_JOURNEY_TEST",
    title: "Guest Journey test issue",
    issue: "A current operational signal exists.",
    operationalImpact: "Operational follow-up is required.",
    recommendedAction: "Review the reservation.",
    nextAutomaticStep: null,
    engine: "GUEST_JOURNEY",
    severity: "WARNING",
    workflowState: "ACTION_REQUIRED",
    visibility: "HOST",
    responsibleActor: "HOST",
    actionRequired: true,
    canAutoResolve: false,
    autoResolveStatus: "NOT_SUPPORTED",
    reservationId: "reservation-1",
    reservationNumber: "PG-2026-000001",
    guestName: "Guest",
    cleanerName: null,
    firstDetectedAt: new Date("2026-08-24T12:00:00.000Z"),
    lastSignalAt: new Date("2026-08-24T12:05:00.000Z"),
    resolvedAt: null,
    resolutionCode: null,
    resolutionSummary: null,
    resolutionType: null,
    resolvedBy: null,
    actionTarget: "RESERVATION",
    openUrl: "/reservations/reservation-1",
    secondaryActionUrl: null,
    ...overrides,
  };
}

test("E12 reports ACTIVE when OperationalIssue has no unresolved current state", () => {
  const projection = projectMissionControlOperationalState([
    issue({
      workflowState: "RESOLVED",
      resolvedAt: new Date("2026-08-24T12:10:00.000Z"),
    }),
  ]);

  const summary = deriveMissionControlCurrentStateSummary(
    projection.currentOperationalState
  );

  assert.equal(summary.autopilotStatus, "ACTIVE");
  assert.deepEqual(summary.engineHealth, []);
});

test("E12 reports NEEDS_ATTENTION only from current host-action OperationalIssue", () => {
  const projection = projectMissionControlOperationalState([
    issue(),
  ]);

  const summary = deriveMissionControlCurrentStateSummary(
    projection.currentOperationalState
  );

  assert.equal(summary.autopilotStatus, "NEEDS_ATTENTION");
  assert.equal(summary.engineHealth.length, 1);
  assert.equal(summary.engineHealth[0]?.engine, "GUEST_JOURNEY");
  assert.equal(summary.engineHealth[0]?.status, "WARNING");
});

test("E12 reports ERROR from a current critical OperationalIssue", () => {
  const projection = projectMissionControlOperationalState([
    issue({
      severity: "CRITICAL",
      workflowState: "AUTO_RESOLVING",
      responsibleActor: "SYSTEM",
      actionRequired: false,
      canAutoResolve: true,
      autoResolveStatus: "RUNNING",
    }),
  ]);

  const summary = deriveMissionControlCurrentStateSummary(
    projection.currentOperationalState
  );

  assert.equal(summary.autopilotStatus, "ERROR");
  assert.equal(summary.engineHealth[0]?.status, "ERROR");
});

test("E12 waiting or auto-resolving warning state does not require host attention", () => {
  const projection = projectMissionControlOperationalState([
    issue({
      workflowState: "WAITING",
      responsibleActor: "SYSTEM",
      actionRequired: false,
    }),
    issue({
      issueCode: "GUEST_JOURNEY_AUTO",
      workflowState: "AUTO_RESOLVING",
      responsibleActor: "SYSTEM",
      actionRequired: false,
      canAutoResolve: true,
      autoResolveStatus: "RUNNING",
    }),
  ]);

  const summary = deriveMissionControlCurrentStateSummary(
    projection.currentOperationalState
  );

  assert.equal(summary.autopilotStatus, "ACTIVE");
  assert.equal(summary.engineHealth[0]?.status, "WARNING");
});
