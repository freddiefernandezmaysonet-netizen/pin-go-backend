import assert from "node:assert/strict";
import test from "node:test";

import {
  APMS_ENGINE_IDS,
} from "../engine-operational-contract";
import type {
  ApmsEngineId,
} from "../engine-operational-contract";
import {
  buildMissionControlReadModel,
} from "../mission-control-read-model";
import type {
  MissionControlEngineReadiness,
  MissionControlOperationalProjection,
} from "../mission-control-read-model";

function createReadiness(
  overrides: Partial<
    Record<
      ApmsEngineId,
      Partial<MissionControlEngineReadiness>
    >
  > = {}
) {
  return Object.fromEntries(
    APMS_ENGINE_IDS.map((engineId) => [
      engineId,
      {
        enabled: true,
        configured: true,
        applicable: true,
        reasonCode: `${engineId}_HEALTHY`,
        summary: `${engineId} is healthy.`,
        dependencies: [],
        evidenceRefs: [],
        ...(overrides[engineId] ?? {}),
      },
    ])
  ) as Record<
    ApmsEngineId,
    MissionControlEngineReadiness
  >;
}

function buildModel(input?: {
  readiness?: ReturnType<typeof createReadiness>;
  operationalItems?: MissionControlOperationalProjection[];
}) {
  return buildMissionControlReadModel({
    organizationId: "org-test",
    generatedAt: new Date(
      "2026-07-24T12:00:00.000Z"
    ),
    readiness:
      input?.readiness ?? createReadiness(),
    operationalItems:
      input?.operationalItems ?? [],
  });
}

test("returns exactly eight engines in canonical order", () => {
  const model = buildModel();

  assert.deepEqual(
    model.engines.map(
      (engine) => engine.engineId
    ),
    APMS_ENGINE_IDS
  );
  assert.equal(model.engines.length, 8);
  assert.equal(model.counts.healthy, 8);
  assert.equal(model.counts.autoResolving, 0);
  assert.equal(
    model.counts.hostActionRequired,
    0
  );
  assert.equal(model.counts.disabled, 0);
  assert.equal(model.needsHostAction, false);
  assert.equal(model.hostActionCount, 0);
  assert.equal(model.autoResolvingCount, 0);
  assert.deepEqual(model.hostActions, []);
  assert.deepEqual(model.automaticWork, []);
  assert.deepEqual(model.recentResolutions, []);
});

test("automatic work remains blue even when configuration is disabled", () => {
  const readiness = createReadiness({
    ACCESS: {
      enabled: false,
      configured: false,
      applicable: false,
      reasonCode: "ACCESS_DISABLED",
      summary: "Access is disabled.",
    },
  });

  const model = buildModel({
    readiness,
    operationalItems: [
      {
        issueId: "issue-access-waiting",
        issueCode:
          "ACCESS_REVOKE_RETRY_SCHEDULED",
        title: "Access revoke retry scheduled",
        issue:
          "Pin&Go is retrying a failed access revoke.",
        engine: "Access",
        workflowState: "WAITING",
        actionRequired: false,
        responsibleActor: "PIN_GO",
        nextAutomaticStep:
          "Pin&Go will retry the revoke in five minutes.",
        actionTarget: "ACCESS",
        reservationId: "reservation-1",
        reservationNumber: "PG-1001",
        propertyId: "property-1",
        guestName: "Test Guest",
        lastSignalAt:
          "2026-07-24T11:59:00.000Z",
        nextAttemptAt:
          "2026-07-24T12:04:00.000Z",
        attempt: 2,
        maxAttempts: 7,
        exhausted: false,
      },
    ],
  });

  const access = model.engines.find(
    (engine) => engine.engineId === "ACCESS"
  );
  const automaticWork =
    model.automaticWork[0];

  assert.ok(access);
  assert.ok(automaticWork);
  assert.equal(
    access.state,
    "AUTO_RESOLVING"
  );
  assert.equal(
    access.hostActionRequired,
    false
  );
  assert.equal(access.attempt, 2);
  assert.equal(access.maxAttempts, 7);
  assert.equal(access.exhausted, false);
  assert.equal(model.needsHostAction, false);
  assert.equal(model.hostActionCount, 0);
  assert.equal(model.autoResolvingCount, 1);
  assert.equal(model.hostActions.length, 0);
  assert.equal(model.automaticWork.length, 1);
  assert.equal(
    automaticWork.engineId,
    "ACCESS"
  );
  assert.equal(
    automaticWork.reservationNumber,
    "PG-1001"
  );
  assert.equal(automaticWork.attempt, 2);
  assert.equal(automaticWork.maxAttempts, 7);
  assert.equal(automaticWork.exhausted, false);
});

test("host action overrides automatic work and disabled configuration", () => {
  const readiness = createReadiness({
    ACCESS: {
      enabled: false,
      configured: false,
      applicable: false,
      reasonCode: "ACCESS_DISABLED",
      summary: "Access is disabled.",
    },
  });

  const model = buildModel({
    readiness,
    operationalItems: [
      {
        issueId: "issue-access-waiting",
        issueCode:
          "ACCESS_REVOKE_RETRY_SCHEDULED",
        title: "Access revoke retry scheduled",
        issue:
          "Pin&Go is retrying a failed access revoke.",
        engine: "ACCESS",
        workflowState: "AUTO_RESOLVING",
        actionRequired: false,
        responsibleActor: "PIN_GO",
        nextAutomaticStep:
          "Pin&Go will retry automatically.",
        lastSignalAt:
          "2026-07-24T11:55:00.000Z",
      },
      {
        issueId: "issue-access-exhausted",
        issueCode:
          "ACCESS_REVOKE_RECOVERY_EXHAUSTED",
        title: "Access revoke requires authorization",
        issue:
          "Pin&Go exhausted the permitted revoke attempts.",
        engine: "Access",
        workflowState: "ACTION_REQUIRED",
        actionRequired: true,
        responsibleActor: "HOST",
        recommendedAction:
          "Authorize the next recovery action.",
        actionTarget: "ACCESS",
        reservationId: "reservation-2",
        propertyId: "property-1",
        lastSignalAt:
          "2026-07-24T11:59:00.000Z",
        attempt: 7,
        maxAttempts: 7,
        exhausted: true,
      },
    ],
  });

  const access = model.engines.find(
    (engine) => engine.engineId === "ACCESS"
  );
  const hostAction = model.hostActions[0];

  assert.ok(access);
  assert.ok(hostAction);
  assert.equal(
    access.state,
    "HOST_ACTION_REQUIRED"
  );
  assert.equal(
    access.hostActionRequired,
    true
  );
  assert.equal(access.hostActionCount, 1);
  assert.equal(access.exhausted, true);
  assert.equal(model.needsHostAction, true);
  assert.equal(model.hostActionCount, 1);
  assert.equal(model.autoResolvingCount, 1);
  assert.equal(model.hostActions.length, 1);
  assert.equal(model.automaticWork.length, 1);
  assert.equal(
    hostAction.issueCode,
    "ACCESS_REVOKE_RECOVERY_EXHAUSTED"
  );
  assert.equal(hostAction.engineId, "ACCESS");
  assert.equal(hostAction.exhausted, true);
  assert.equal(
    hostAction.recommendedAction,
    "Authorize the next recovery action."
  );
  assert.equal("issueId" in hostAction, false);
  assert.equal("operationalKey" in hostAction, false);
  assert.equal("metadata" in hostAction, false);
});

test("resolved issues do not change current engine state and remain in recent history", () => {
  const model = buildModel({
    operationalItems: [
      {
        issueId: "issue-resolved",
        issueCode: "GATEWAY_RECOVERED",
        title: "Gateway restored",
        issue:
          "Pin&Go confirmed gateway connectivity.",
        engine: "Device Health",
        workflowState: "RESOLVED",
        actionRequired: false,
        responsibleActor: "NONE",
        actionTarget: "ACCESS",
        propertyId: "property-1",
        lastSignalAt:
          "2026-07-24T11:50:00.000Z",
        resolvedAt:
          "2026-07-24T11:51:00.000Z",
        resolutionSummary:
          "Gateway connectivity was restored automatically.",
        resolutionType: "AUTOMATIC",
        exhausted: true,
      },
    ],
  });

  const deviceHealth = model.engines.find(
    (engine) =>
      engine.engineId === "DEVICE_HEALTH"
  );
  const recentResolution =
    model.recentResolutions[0];

  assert.ok(deviceHealth);
  assert.ok(recentResolution);
  assert.equal(
    deviceHealth.state,
    "HEALTHY"
  );
  assert.equal(
    deviceHealth.activeIssueCount,
    0
  );
  assert.equal(model.hostActions.length, 0);
  assert.equal(model.automaticWork.length, 0);
  assert.equal(model.recentResolutions.length, 1);
  assert.equal(
    recentResolution.engineId,
    "DEVICE_HEALTH"
  );
  assert.equal(
    recentResolution.resolvedAt,
    "2026-07-24T11:51:00.000Z"
  );
  assert.equal(
    recentResolution.resolutionType,
    "AUTOMATIC"
  );
  assert.equal(recentResolution.exhausted, false);
});

test("normalizes legacy Messaging and Distribution engine names", () => {
  const model = buildModel({
    operationalItems: [
      {
        issueId: "issue-message",
        issueCode: "SMS_RETRY_SCHEDULED",
        title: "SMS retry scheduled",
        issue:
          "Pin&Go will retry the SMS.",
        engine: "Messaging",
        workflowState: "WAITING",
        actionRequired: false,
        responsibleActor: "PIN_GO",
        nextAutomaticStep:
          "Retry the SMS automatically.",
        lastSignalAt:
          "2026-07-24T11:58:00.000Z",
      },
      {
        issueId: "issue-distribution",
        issueCode:
          "PMS_LISTING_MAPPING_REQUIRED",
        title: "PMS listing mapping required",
        issue:
          "A PMS listing cannot be mapped automatically.",
        engine: "Distribution",
        workflowState: "ACTION_REQUIRED",
        actionRequired: true,
        responsibleActor: "HOST",
        lastSignalAt:
          "2026-07-24T11:59:00.000Z",
      },
    ],
  });

  const communications = model.engines.find(
    (engine) =>
      engine.engineId === "COMMUNICATIONS"
  );
  const distribution = model.engines.find(
    (engine) =>
      engine.engineId === "DISTRIBUTION_PMS"
  );

  assert.ok(communications);
  assert.ok(distribution);
  assert.equal(
    communications.state,
    "AUTO_RESOLVING"
  );
  assert.equal(
    distribution.state,
    "HOST_ACTION_REQUIRED"
  );
  assert.equal(
    model.automaticWork[0]?.engineId,
    "COMMUNICATIONS"
  );
  assert.equal(
    model.hostActions[0]?.engineId,
    "DISTRIBUTION_PMS"
  );
});

test("orders active and resolved workflow collections by latest signal", () => {
  const model = buildModel({
    operationalItems: [
      {
        issueCode: "CLEANING_WAITING_OLD",
        title: "Older cleaning wait",
        issue: "Waiting for a cleaner.",
        engine: "Cleaning",
        workflowState: "WAITING",
        actionRequired: false,
        responsibleActor: "CLEANER",
        nextAutomaticStep:
          "Pin&Go will continue the cleaning workflow.",
        lastSignalAt:
          "2026-07-24T10:00:00.000Z",
      },
      {
        issueCode: "COMMUNICATION_RETRY_NEW",
        title: "Newer communication retry",
        issue: "Retrying a message.",
        engine: "Communications",
        workflowState: "AUTO_RESOLVING",
        actionRequired: false,
        responsibleActor: "PIN_GO",
        nextAutomaticStep:
          "Pin&Go will retry the message.",
        lastSignalAt:
          "2026-07-24T11:00:00.000Z",
      },
      {
        issueCode: "REVENUE_RESOLVED_OLD",
        title: "Older revenue resolution",
        issue: "Revenue decision completed.",
        engine: "Revenue",
        workflowState: "RESOLVED",
        actionRequired: false,
        responsibleActor: "NONE",
        lastSignalAt:
          "2026-07-23T10:00:00.000Z",
        resolvedAt:
          "2026-07-23T10:01:00.000Z",
      },
      {
        issueCode: "FINANCIAL_RESOLVED_NEW",
        title: "Newer financial resolution",
        issue: "Financial workflow completed.",
        engine: "Financial",
        workflowState: "RESOLVED",
        actionRequired: false,
        responsibleActor: "NONE",
        lastSignalAt:
          "2026-07-24T09:00:00.000Z",
        resolvedAt:
          "2026-07-24T09:01:00.000Z",
      },
    ],
  });

  assert.deepEqual(
    model.automaticWork.map(
      (item) => item.issueCode
    ),
    [
      "COMMUNICATION_RETRY_NEW",
      "CLEANING_WAITING_OLD",
    ]
  );
  assert.deepEqual(
    model.recentResolutions.map(
      (item) => item.issueCode
    ),
    [
      "FINANCIAL_RESOLVED_NEW",
      "REVENUE_RESOLVED_OLD",
    ]
  );
});
