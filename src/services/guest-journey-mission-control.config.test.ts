import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveGuestJourneyMissionControlConfig,
} from "./guest-journey-mission-control.config";

test("keeps the E6 Mission Control bridge disabled by default", () => {
  assert.deepEqual(
    resolveGuestJourneyMissionControlConfig(
      {}
    ),
    {
      enabled: false,
      batchSize: 25,
      lookbackDays: 30,
      organizationIds: [],
      propertyIds: [],
    }
  );
});

test("requires an explicit tenant canary when E6 is enabled", () => {
  assert.throws(
    () =>
      resolveGuestJourneyMissionControlConfig({
        GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_ENABLED:
          "true",
      }),
    /MISSION_CONTROL_BRIDGE_SCOPE_REQUIRED/
  );
});

test("normalizes E6 scope and bounded scan controls", () => {
  assert.deepEqual(
    resolveGuestJourneyMissionControlConfig({
      GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_ENABLED:
        "yes",
      GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_ORGANIZATION_IDS:
        " org-b,org-a,org-b ",
      GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_PROPERTY_IDS:
        " property-b, property-a ",
      GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_BATCH_SIZE:
        "100",
      GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_LOOKBACK_DAYS:
        "90",
    }),
    {
      enabled: true,
      batchSize: 100,
      lookbackDays: 90,
      organizationIds: [
        "org-a",
        "org-b",
      ],
      propertyIds: [
        "property-a",
        "property-b",
      ],
    }
  );
});

for (const [name, value] of [
  [
    "GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_BATCH_SIZE",
    "101",
  ],
  [
    "GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_LOOKBACK_DAYS",
    "91",
  ],
] as const) {
  test(`rejects unsafe ${name}`, () => {
    assert.throws(
      () =>
        resolveGuestJourneyMissionControlConfig({
          [name]: value,
        }),
      new RegExp(`${name}_INVALID`)
    );
  });
}

test("rejects ambiguous E6 activation values", () => {
  assert.throws(
    () =>
      resolveGuestJourneyMissionControlConfig({
        GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_ENABLED:
          "sometimes",
      }),
    /MISSION_CONTROL_BRIDGE_ENABLED_INVALID/
  );
});
