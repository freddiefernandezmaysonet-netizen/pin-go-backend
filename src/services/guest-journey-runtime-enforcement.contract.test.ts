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
const propertyRouteSource = readFileSync(
  new URL(
    "../routes/dashboard.properties.route.ts",
    import.meta.url
  ),
  "utf8"
);

test("E12 enforcement remains centralized under the E13 durable runtime gate", () => {
  assert.match(
    workerSource,
    /initializeGuestJourneyRuntimeState\(/
  );
  assert.match(
    workerSource,
    /evaluateGuestJourneyRuntimeTick\(/
  );
  assert.match(
    workerSource,
    /guestJourneyRuntimeAllowed/
  );
  assert.match(
    workerSource,
    /GUEST_JOURNEY_ACTIVATION_CONTROL_PLANE_CONFIG\.enabledStages/
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

test("E13 removes the transitional E12 response middleware", () => {
  assert.doesNotMatch(
    serverSource,
    /missionControlCurrentStateCutoverMiddleware/
  );
  assert.doesNotMatch(
    serverSource,
    /dashboard\.mission-control-current-state\.e12\.middleware/
  );
});

test("Mission Control now derives current health natively from runtime truth and OperationalIssue", () => {
  assert.match(
    propertyRouteSource,
    /deriveMissionControlNativeHealth/
  );
  assert.match(
    propertyRouteSource,
    /prisma\.apmsRuntimeState\.findMany/
  );
  assert.match(
    propertyRouteSource,
    /allVisibilityCurrentIssueRows/
  );
  assert.match(
    propertyRouteSource,
    /visibility:\s*"HOST"/
  );
  assert.match(
    propertyRouteSource,
    /autopilotStatus:\s*\n\s*nativeHealth\.autopilotStatus/
  );
  assert.match(
    propertyRouteSource,
    /engineHealth:\s*\n\s*nativeHealth\.engineHealth/
  );
});
