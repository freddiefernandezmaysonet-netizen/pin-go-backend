import assert from "node:assert/strict";
import test from "node:test";

import type {
  MissionControlOperationalItem,
  MissionControlSnapshot,
} from "../apms/mission-control-types";
import {
  applyMissionControlCurrentStateCutover,
} from "./dashboard.mission-control-current-state.e12.middleware";

function issue(
  overrides: Partial<MissionControlOperationalItem> = {}
): MissionControlOperationalItem {
  return {
    issueCode: "E12_TEST",
    title: "Current issue",
    issue: "Current OperationalIssue signal",
    operationalImpact: "Requires attention",
    recommendedAction: "Review",
    nextAutomaticStep: null,
    engine: "GUEST_JOURNEY",
    severity: "WARNING",
    workflowState: "ACTION_REQUIRED",
    visibility: "HOST",
    responsibleActor: "HOST",
    actionRequired: true,
    canAutoResolve: false,
    autoResolveStatus: "NOT_SUPPORTED",
    reservationId: null,
    reservationNumber: null,
    guestName: null,
    cleanerName: null,
    firstDetectedAt: new Date("2026-08-24T12:00:00.000Z"),
    lastSignalAt: new Date("2026-08-24T12:05:00.000Z"),
    resolvedAt: null,
    resolutionCode: null,
    resolutionSummary: null,
    resolutionType: null,
    resolvedBy: null,
    actionTarget: "RESERVATION",
    openUrl: null,
    secondaryActionUrl: null,
    ...overrides,
  };
}

function legacySnapshot(
  currentOperationalState: MissionControlOperationalItem[]
): MissionControlSnapshot {
  return {
    entityId: "property-1",
    autopilotStatus: "ERROR",
    freedomMetrics: {
      minutesReturned: 100,
      interventionsAvoided: 2,
      autonomousDecisions: 5,
    },
    autonomyScore: {
      score: 90,
      operationalSuccessRate: 90,
      humanInterventions: 1,
    },
    confidenceScore: {
      score: 80,
      engines: {},
    },
    engineHealth: [
      {
        engine: "STALE_AUDIT_ENGINE",
        status: "ERROR",
      },
    ],
    currentOperationalState,
    generatedAt: new Date("2026-08-24T12:06:00.000Z"),
  };
}

test("E12 replaces stale audit current state with OperationalIssue current state", () => {
  const result = applyMissionControlCurrentStateCutover({
    ok: true,
    item: legacySnapshot([]),
  });

  assert.equal(result.item?.autopilotStatus, "ACTIVE");
  assert.deepEqual(result.item?.engineHealth, []);
  assert.equal(
    result.item?.freedomMetrics.minutesReturned,
    100
  );
});

test("E12 preserves history metrics but reports current host action", () => {
  const result = applyMissionControlCurrentStateCutover({
    ok: true,
    item: legacySnapshot([issue()]),
  });

  assert.equal(
    result.item?.autopilotStatus,
    "NEEDS_ATTENTION"
  );
  assert.equal(
    result.item?.engineHealth[0]?.engine,
    "GUEST_JOURNEY"
  );
  assert.equal(
    result.item?.engineHealth[0]?.status,
    "WARNING"
  );
});
