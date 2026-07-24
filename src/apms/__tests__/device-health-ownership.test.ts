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
} from "../mission-control-read-model";

function createReadiness() {
  return Object.fromEntries(
    APMS_ENGINE_IDS.map((engineId) => [
      engineId,
      {
        enabled: true,
        configured: true,
        applicable: true,
        reasonCode:
          `${engineId}_HEALTHY`,
        summary:
          `${engineId} is healthy.`,
        dependencies: [],
        evidenceRefs: [],
      },
    ])
  ) as Record<
    ApmsEngineId,
    MissionControlEngineReadiness
  >;
}

function getEngine(
  model: ReturnType<
    typeof buildMissionControlReadModel
  >,
  engineId: ApmsEngineId
) {
  const engine = model.engines.find(
    (item) => item.engineId === engineId
  );

  assert.ok(engine);

  return engine;
}

test("attributes legacy gateway automatic work to Device Health instead of Access", () => {
  const model =
    buildMissionControlReadModel({
      organizationId: "org-test",
      generatedAt: new Date(
        "2026-07-24T12:00:00.000Z"
      ),
      readiness: createReadiness(),
      operationalItems: [
        {
          issueId: "gateway-waiting",
          issueCode:
            "DEVICE_GATEWAY_OFFLINE_RECHECK_SCHEDULED",
          title:
            "Gateway connectivity is being monitored",
          issue:
            "Pin&Go detected that the gateway is unavailable.",

          // Persisted legacy owner.
          engine: "ACCESS",

          workflowState: "WAITING",
          actionRequired: false,
          responsibleActor: "PIN_GO",
          nextAutomaticStep:
            "Pin&Go will check the gateway again automatically.",
          actionTarget: "ACCESS",
          propertyId: "property-1",
          lastSignalAt:
            "2026-07-24T11:59:00.000Z",
          nextAttemptAt:
            "2026-07-24T13:00:00.000Z",
          exhausted: false,
        },
      ],
    });

  const access = getEngine(
    model,
    "ACCESS"
  );
  const deviceHealth = getEngine(
    model,
    "DEVICE_HEALTH"
  );

  assert.equal(access.state, "HEALTHY");
  assert.equal(access.activeIssueCount, 0);

  assert.equal(
    deviceHealth.state,
    "AUTO_RESOLVING"
  );
  assert.equal(
    deviceHealth.activeIssueCount,
    1
  );
  assert.equal(
    deviceHealth.autoResolvingCount,
    1
  );
  assert.equal(
    model.automaticWork[0]?.engineId,
    "DEVICE_HEALTH"
  );
  assert.equal(model.needsHostAction, false);
});

test("attributes legacy gateway host action to Device Health without turning Access red", () => {
  const model =
    buildMissionControlReadModel({
      organizationId: "org-test",
      generatedAt: new Date(
        "2026-07-24T12:00:00.000Z"
      ),
      readiness: createReadiness(),
      operationalItems: [
        {
          issueId: "gateway-critical",
          issueCode:
            "DEVICE_GATEWAY_OFFLINE_CRITICAL",
          title:
            "Gateway offline before guest check-in",
          issue:
            "The gateway remains offline inside the critical arrival window.",

          // Persisted legacy owner.
          engine: "Access",

          workflowState:
            "ACTION_REQUIRED",
          actionRequired: true,
          responsibleActor: "HOST",
          recommendedAction:
            "Restore gateway connectivity before guest arrival.",
          actionTarget: "ACCESS",
          reservationId: "reservation-1",
          propertyId: "property-1",
          lastSignalAt:
            "2026-07-24T11:59:00.000Z",
          exhausted: false,
        },
      ],
    });

  const access = getEngine(
    model,
    "ACCESS"
  );
  const deviceHealth = getEngine(
    model,
    "DEVICE_HEALTH"
  );

  assert.equal(access.state, "HEALTHY");
  assert.equal(access.hostActionCount, 0);

  assert.equal(
    deviceHealth.state,
    "HOST_ACTION_REQUIRED"
  );
  assert.equal(
    deviceHealth.hostActionCount,
    1
  );
  assert.equal(model.needsHostAction, true);
  assert.equal(model.hostActionCount, 1);
  assert.equal(
    model.hostActions[0]?.engineId,
    "DEVICE_HEALTH"
  );
});
