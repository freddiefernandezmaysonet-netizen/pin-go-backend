import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveGuestJourneyInternalReconcileConfig,
} from "./guest-journey-internal-reconcile.config";

test(
  "keeps internal reconciliation disabled by default",
  () => {
    assert.deepEqual(
      resolveGuestJourneyInternalReconcileConfig(
        {}
      ),
      {
        enabled: false,
        batchSize: 10,
        horizonDays: 90,
        lookbackDays: 7,
        organizationIds: [],
        propertyIds: [],
      }
    );
  }
);

test(
  "requires an explicit tenant canary scope when enabled",
  () => {
    assert.throws(
      () =>
        resolveGuestJourneyInternalReconcileConfig(
          {
            GUEST_JOURNEY_INTERNAL_RECONCILE_ENABLED:
              "true",
          }
        ),
      /GUEST_JOURNEY_INTERNAL_RECONCILE_SCOPE_REQUIRED/
    );
  }
);

test(
  "normalizes canary scopes and bounded values",
  () => {
    assert.deepEqual(
      resolveGuestJourneyInternalReconcileConfig(
        {
          GUEST_JOURNEY_INTERNAL_RECONCILE_ENABLED:
            "on",
          GUEST_JOURNEY_INTERNAL_RECONCILE_BATCH_SIZE:
            "25",
          GUEST_JOURNEY_INTERNAL_RECONCILE_HORIZON_DAYS:
            "120",
          GUEST_JOURNEY_INTERNAL_RECONCILE_LOOKBACK_DAYS:
            "14",
          GUEST_JOURNEY_INTERNAL_RECONCILE_ORGANIZATION_IDS:
            " org-2,org-1,org-2 ",
          GUEST_JOURNEY_INTERNAL_RECONCILE_PROPERTY_IDS:
            "property-1",
        }
      ),
      {
        enabled: true,
        batchSize: 25,
        horizonDays: 120,
        lookbackDays: 14,
        organizationIds: [
          "org-1",
          "org-2",
        ],
        propertyIds: ["property-1"],
      }
    );
  }
);

for (const name of [
  "GUEST_JOURNEY_INTERNAL_RECONCILE_BATCH_SIZE",
  "GUEST_JOURNEY_INTERNAL_RECONCILE_HORIZON_DAYS",
  "GUEST_JOURNEY_INTERNAL_RECONCILE_LOOKBACK_DAYS",
] as const) {
  test(
    `rejects an invalid ${name}`,
    () => {
      assert.throws(
        () =>
          resolveGuestJourneyInternalReconcileConfig(
            {
              [name]: "0",
            }
          ),
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
        resolveGuestJourneyInternalReconcileConfig(
          {
            GUEST_JOURNEY_INTERNAL_RECONCILE_ENABLED:
              "maybe",
          }
        ),
      /GUEST_JOURNEY_INTERNAL_RECONCILE_ENABLED_INVALID/
    );
  }
);
