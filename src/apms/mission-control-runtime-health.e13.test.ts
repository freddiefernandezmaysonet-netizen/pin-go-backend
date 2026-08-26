import assert from "node:assert/strict";
import test from "node:test";

import type {
  MissionControlOperationalItem,
} from "./mission-control-types";
import {
  deriveMissionControlNativeHealth,
  type MissionControlRuntimeHealthRow,
} from "./mission-control-runtime-health.e13";
import {
  hashGuestJourneyRuntimeScopeId,
} from "../services/guest-journey-runtime-state.service";

const NOW = new Date(
  "2026-08-25T12:00:00.000Z"
);

function runtime(
  overrides: Partial<
    MissionControlRuntimeHealthRow
  > = {}
): MissionControlRuntimeHealthRow {
  return {
    runtimeName: "GUEST_JOURNEY",
    environment: "test",
    serviceName: "reservation-worker",
    activationProfile: "shadow_only",
    configFingerprint: "a".repeat(64),
    scopeFingerprint: "b".repeat(64),
    organizationScopeHashes: [
      hashGuestJourneyRuntimeScopeId(
        "organization",
        "org-1"
      ),
    ],
    propertyScopeHashes: [],
    status: "ACTIVE",
    preflightStatus: "PASSED",
    lastHeartbeatAt: new Date(
      NOW.getTime() - 5_000
    ),
    ...overrides,
  };
}

function issue(
  overrides: Partial<
    MissionControlOperationalItem
  > = {}
): MissionControlOperationalItem {
  return {
    issueCode: "TEST_ISSUE",
    title: "Host-safe title",
    issue: "Host-safe issue",
    operationalImpact:
      "Host-safe operational impact",
    recommendedAction: null,
    nextAutomaticStep: null,
    engine: "GUEST_JOURNEY",
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
    firstDetectedAt: new Date(
      NOW.getTime() - 20_000
    ),
    lastSignalAt: new Date(
      NOW.getTime() - 10_000
    ),
    resolvedAt: null,
    resolutionCode: null,
    resolutionSummary: null,
    resolutionType: null,
    resolvedBy: null,
    actionTarget: "SYSTEM",
    openUrl: null,
    secondaryActionUrl: null,
    ...overrides,
  };
}

function derive(input?: {
  runtimeRows?:
    MissionControlRuntimeHealthRow[];
  issues?:
    MissionControlOperationalItem[];
}) {
  return deriveMissionControlNativeHealth({
    runtimeRows:
      input?.runtimeRows ?? [runtime()],
    allVisibilityCurrentIssues:
      input?.issues ?? [],
    organizationId: "org-1",
    propertyId: "property-1",
    now: NOW,
    staleAfterMs: 60_000,
  });
}

test("E13 maps fresh OFF runtime to PAUSED", () => {
  assert.equal(
    derive({
      runtimeRows: [
        runtime({
          activationProfile: "off",
          status: "OFF",
          preflightStatus:
            "NOT_REQUIRED",
          organizationScopeHashes: [],
        }),
      ],
    }).autopilotStatus,
    "PAUSED"
  );
});

test("E13 maps enabled fresh preflight-passed runtime to ACTIVE", () => {
  const result = derive();
  assert.equal(result.autopilotStatus, "ACTIVE");
  assert.equal(
    result.engineHealth.find(
      (entry) =>
        entry.engine === "GUEST_JOURNEY"
    )?.status,
    "HEALTHY"
  );
});

test("E13 maps missing, stale, starting, and out-of-scope runtime to PAUSED", () => {
  assert.equal(
    derive({ runtimeRows: [] }).autopilotStatus,
    "PAUSED"
  );
  assert.equal(
    derive({
      runtimeRows: [
        runtime({
          lastHeartbeatAt: new Date(
            NOW.getTime() - 61_000
          ),
        }),
      ],
    }).autopilotStatus,
    "PAUSED"
  );
  assert.equal(
    derive({
      runtimeRows: [
        runtime({
          status: "STARTING",
          preflightStatus: "PENDING",
        }),
      ],
    }).autopilotStatus,
    "PAUSED"
  );
  assert.equal(
    deriveMissionControlNativeHealth({
      runtimeRows: [runtime()],
      allVisibilityCurrentIssues: [],
      organizationId: "org-other",
      propertyId: "property-other",
      now: NOW,
    }).autopilotStatus,
    "PAUSED"
  );
});

test("E13 maps blocked, error, or failed-preflight runtime to ERROR", () => {
  for (const row of [
    runtime({ status: "BLOCKED" }),
    runtime({ status: "ERROR" }),
    runtime({
      status: "STARTING",
      preflightStatus: "FAILED",
    }),
  ]) {
    assert.equal(
      derive({ runtimeRows: [row] })
        .autopilotStatus,
      "ERROR"
    );
  }
});

test("E13 detects fresh configuration drift across instances", () => {
  const result = derive({
    runtimeRows: [
      runtime(),
      runtime({
        configFingerprint:
          "c".repeat(64),
      }),
    ],
  });
  assert.equal(result.runtimeDriftDetected, true);
  assert.equal(result.autopilotStatus, "ERROR");
});

test("E13 uses DEVELOPER CRITICAL issue for health without leaking details", () => {
  const result = derive({
    issues: [
      issue({
        title:
          "Internal database secret detail",
        issue:
          "Internal stack and scope details",
        operationalImpact:
          "Internal impact details",
        visibility: "DEVELOPER",
        severity: "CRITICAL",
        workflowState:
          "ACTION_REQUIRED",
        actionRequired: true,
      }),
    ],
  });
  const health = result.engineHealth.find(
    (entry) =>
      entry.engine === "GUEST_JOURNEY"
  );

  assert.equal(result.autopilotStatus, "ERROR");
  assert.equal(health?.status, "ERROR");
  assert.doesNotMatch(
    String(health?.message),
    /database secret|stack|scope/i
  );
});

test("E13 maps HOST ACTION_REQUIRED to NEEDS_ATTENTION", () => {
  assert.equal(
    derive({
      issues: [
        issue({
          workflowState:
            "ACTION_REQUIRED",
          responsibleActor: "HOST",
          actionRequired: true,
          canAutoResolve: false,
          autoResolveStatus:
            "NOT_SUPPORTED",
        }),
      ],
    }).autopilotStatus,
    "NEEDS_ATTENTION"
  );
});

test("E13 ignores resolved/history-only issues for current health", () => {
  const result = derive({
    issues: [
      issue({
        severity: "CRITICAL",
        workflowState: "RESOLVED",
        resolvedAt: new Date(
          NOW.getTime() - 1_000
        ),
        actionRequired: false,
        canAutoResolve: true,
        autoResolveStatus: "SUCCEEDED",
        resolutionCode: "RESOLVED",
        resolutionSummary: "Resolved",
        resolutionType: "AUTOMATIC",
        resolvedBy: "PIN_GO",
      }),
    ],
  });

  assert.equal(result.autopilotStatus, "ACTIVE");
  assert.equal(
    result.engineHealth.find(
      (entry) =>
        entry.engine === "GUEST_JOURNEY"
    )?.status,
    "HEALTHY"
  );
});


test("E13 stale runtime issue preserves evidence but current health becomes PAUSED", () => {
  const result = derive({
    runtimeRows: [
      runtime({
        lastHeartbeatAt: new Date(
          NOW.getTime() - 61_000
        ),
      }),
    ],
    issues: [
      issue({
        issueCode:
          "GUEST_JOURNEY_RUNTIME_BLOCKED",
        visibility: "DEVELOPER",
        severity: "CRITICAL",
        workflowState:
          "ACTION_REQUIRED",
        actionRequired: true,
        canAutoResolve: false,
        autoResolveStatus:
          "NOT_SUPPORTED",
      }),
    ],
  });

  assert.equal(
    result.autopilotStatus,
    "PAUSED"
  );
  assert.equal(
    result.engineHealth.find(
      (entry) =>
        entry.engine === "GUEST_JOURNEY"
    )?.status,
    "WARNING"
  );
});

test("E13 fresh failed runtime and its durable issue remain ERROR", () => {
  const result = derive({
    runtimeRows: [
      runtime({
        status: "BLOCKED",
        preflightStatus: "FAILED",
      }),
    ],
    issues: [
      issue({
        issueCode:
          "GUEST_JOURNEY_RUNTIME_BLOCKED",
        visibility: "DEVELOPER",
        severity: "CRITICAL",
        workflowState:
          "ACTION_REQUIRED",
        actionRequired: true,
        canAutoResolve: false,
        autoResolveStatus:
          "NOT_SUPPORTED",
      }),
    ],
  });

  assert.equal(
    result.autopilotStatus,
    "ERROR"
  );
  assert.equal(
    result.engineHealth.find(
      (entry) =>
        entry.engine === "GUEST_JOURNEY"
    )?.status,
    "ERROR"
  );
});
