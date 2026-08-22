import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveGuestJourneyCoordinationConfig,
} from "./guest-journey-coordination.config";

test(
  "keeps E4 disabled by default",
  () => {
    assert.deepEqual(
      resolveGuestJourneyCoordinationConfig(
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
  "requires an explicit canary scope when enabled",
  () => {
    assert.throws(
      () =>
        resolveGuestJourneyCoordinationConfig(
          {
            GUEST_JOURNEY_COORDINATION_INTENTS_ENABLED:
              "true",
          }
        ),
      /COORDINATION_INTENTS_SCOPE_REQUIRED/
    );
  }
);

test(
  "normalizes bounded configuration and canary identifiers",
  () => {
    assert.deepEqual(
      resolveGuestJourneyCoordinationConfig(
        {
          GUEST_JOURNEY_COORDINATION_INTENTS_ENABLED:
            "yes",
          GUEST_JOURNEY_COORDINATION_INTENTS_BATCH_SIZE:
            "25",
          GUEST_JOURNEY_COORDINATION_INTENTS_HORIZON_DAYS:
            "120",
          GUEST_JOURNEY_COORDINATION_INTENTS_LOOKBACK_DAYS:
            "14",
          GUEST_JOURNEY_COORDINATION_INTENTS_ORGANIZATION_IDS:
            "org-2, org-1,org-2",
          GUEST_JOURNEY_COORDINATION_INTENTS_PROPERTY_IDS:
            "property-2, property-1",
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
        propertyIds: [
          "property-1",
          "property-2",
        ],
      }
    );
  }
);

test(
  "rejects invalid activation and unsafe bounds",
  () => {
    assert.throws(
      () =>
        resolveGuestJourneyCoordinationConfig(
          {
            GUEST_JOURNEY_COORDINATION_INTENTS_ENABLED:
              "sometimes",
          }
        ),
      /ENABLED_INVALID/
    );

    assert.throws(
      () =>
        resolveGuestJourneyCoordinationConfig(
          {
            GUEST_JOURNEY_COORDINATION_INTENTS_BATCH_SIZE:
              "51",
          }
        ),
      /BATCH_SIZE_INVALID/
    );
  }
);
