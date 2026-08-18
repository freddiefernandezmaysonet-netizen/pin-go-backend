import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveGuestJourneyShadowConfig,
} from "./guest-journey-shadow.config";

test(
  "is disabled by default with bounded defaults",
  () => {
    const config =
      resolveGuestJourneyShadowConfig({});

    assert.deepEqual(config, {
      enabled: false,
      batchSize: 10,
      horizonDays: 90,
      lookbackDays: 7,
      organizationIds: [],
      propertyIds: [],
    });
  }
);

test(
  "requires an explicit tenant scope when enabled",
  () => {
    assert.throws(
      () =>
        resolveGuestJourneyShadowConfig({
          GUEST_JOURNEY_SHADOW_ENABLED:
            "true",
        }),
      /GUEST_JOURNEY_SHADOW_SCOPE_REQUIRED/
    );
  }
);

test(
  "normalizes canary scopes and safe limits",
  () => {
    const config =
      resolveGuestJourneyShadowConfig({
        GUEST_JOURNEY_SHADOW_ENABLED: "on",
        GUEST_JOURNEY_SHADOW_BATCH_SIZE:
          "25",
        GUEST_JOURNEY_SHADOW_HORIZON_DAYS:
          "120",
        GUEST_JOURNEY_SHADOW_LOOKBACK_DAYS:
          "14",
        GUEST_JOURNEY_SHADOW_ORGANIZATION_IDS:
          " org-2,org-1,org-2 ",
        GUEST_JOURNEY_SHADOW_PROPERTY_IDS:
          "property-1",
      });

    assert.deepEqual(config, {
      enabled: true,
      batchSize: 25,
      horizonDays: 120,
      lookbackDays: 14,
      organizationIds: ["org-1", "org-2"],
      propertyIds: ["property-1"],
    });
  }
);

for (const name of [
  "GUEST_JOURNEY_SHADOW_BATCH_SIZE",
  "GUEST_JOURNEY_SHADOW_HORIZON_DAYS",
  "GUEST_JOURNEY_SHADOW_LOOKBACK_DAYS",
] as const) {
  test(
    `rejects an invalid ${name}`,
    () => {
      assert.throws(
        () =>
          resolveGuestJourneyShadowConfig({
            [name]: "0",
          }),
        new RegExp(`${name}_INVALID`)
      );
    }
  );
}

test(
  "fails closed on an ambiguous activation value",
  () => {
    assert.throws(
      () =>
        resolveGuestJourneyShadowConfig({
          GUEST_JOURNEY_SHADOW_ENABLED:
            "maybe",
        }),
      /GUEST_JOURNEY_SHADOW_ENABLED_INVALID/
    );
  }
);
