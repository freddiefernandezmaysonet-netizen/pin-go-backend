import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workerSource = readFileSync(
  new URL("../workers/reservation.worker.ts", import.meta.url),
  "utf8"
);
const serverSource = readFileSync(
  new URL("../server.ts", import.meta.url),
  "utf8"
);
const cutoverSource = readFileSync(
  new URL(
    "../routes/dashboard.mission-control-current-state.e12.middleware.ts",
    import.meta.url
  ),
  "utf8"
);

test("E12 reservation.worker consumes the E11 activation control plane", () => {
  assert.match(
    workerSource,
    /resolveGuestJourneyActivationControlPlaneConfig\(\)/
  );
  assert.match(
    workerSource,
    /GUEST_JOURNEY_ACTIVATION_CONTROL_PLANE_CONFIG\.configs/
  );
  assert.match(
    workerSource,
    /verifyGuestJourneyRuntimeScope\(/
  );
  assert.match(
    workerSource,
    /guestJourneyRuntimeAllowed/
  );

  for (const legacyResolver of [
    "resolveGuestJourneyShadowConfig()",
    "resolveGuestJourneyInternalReconcileConfig()",
    "resolveGuestJourneyCoordinationConfig()",
    "resolveGuestJourneyOwnerRuntimeConfig()",
    "resolveGuestJourneyMissionControlConfig()",
    "resolveGuestJourneyCommunicationsOwnerConfig()",
    "resolveGuestJourneyAccessOwnerConfig()",
    "resolveGuestJourneyFinancialOwnerConfig()",
    "resolveGuestJourneyComplianceOwnerConfig()",
  ]) {
    assert.equal(
      workerSource.includes(legacyResolver),
      false,
      `reservation.worker must not independently resolve ${legacyResolver}`
    );
  }
});

test("E12 registers the Mission Control current-state cutover before the legacy property router", () => {
  const cutoverIndex = serverSource.indexOf(
    "app.use(missionControlCurrentStateCutoverMiddleware);"
  );
  const propertyRouterIndex = serverSource.indexOf(
    "app.use(dashboardPropertiesRouter);"
  );

  assert.ok(cutoverIndex >= 0);
  assert.ok(propertyRouterIndex >= 0);
  assert.ok(cutoverIndex < propertyRouterIndex);
});

test("E12 current-state cutover derives current fields from currentOperationalState and preserves audit history", () => {
  assert.match(
    cutoverSource,
    /deriveMissionControlCurrentStateSummary/
  );
  assert.match(
    cutoverSource,
    /currentOperationalState/
  );
  assert.match(
    cutoverSource,
    /ApmsAuditEntry remains in/
  );
  assert.doesNotMatch(
    cutoverSource,
    /apmsAuditEntry\.(findMany|findFirst)/
  );
});
