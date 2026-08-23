import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveGuestJourneyOwnerRuntimeConfig,
} from "./guest-journey-owner-runtime.config";

test("keeps the E5 owner runtime disabled by default", () => {
  assert.deepEqual(
    resolveGuestJourneyOwnerRuntimeConfig(
      {}
    ),
    {
      enabled: false,
      batchSize: 10,
      leaseMs: 120_000,
      maxClaims: 5,
      retryBaseMs: 60_000,
      organizationIds: [],
      propertyIds: [],
    }
  );
});

test("requires an explicit tenant canary when enabled", () => {
  assert.throws(
    () =>
      resolveGuestJourneyOwnerRuntimeConfig({
        GUEST_JOURNEY_OWNER_RUNTIME_ENABLED:
          "true",
      }),
    /OWNER_RUNTIME_SCOPE_REQUIRED/
  );
});

test("normalizes canary identifiers and bounded runtime controls", () => {
  assert.deepEqual(
    resolveGuestJourneyOwnerRuntimeConfig({
      GUEST_JOURNEY_OWNER_RUNTIME_ENABLED:
        "yes",
      GUEST_JOURNEY_OWNER_RUNTIME_ORGANIZATION_IDS:
        " org-b,org-a,org-b ",
      GUEST_JOURNEY_OWNER_RUNTIME_PROPERTY_IDS:
        " property-b, property-a ",
      GUEST_JOURNEY_OWNER_RUNTIME_BATCH_SIZE:
        "25",
      GUEST_JOURNEY_OWNER_RUNTIME_LEASE_MS:
        "30000",
      GUEST_JOURNEY_OWNER_RUNTIME_MAX_CLAIMS:
        "10",
      GUEST_JOURNEY_OWNER_RUNTIME_RETRY_BASE_MS:
        "1000",
    }),
    {
      enabled: true,
      batchSize: 25,
      leaseMs: 30_000,
      maxClaims: 10,
      retryBaseMs: 1_000,
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
    "GUEST_JOURNEY_OWNER_RUNTIME_BATCH_SIZE",
    "26",
  ],
  [
    "GUEST_JOURNEY_OWNER_RUNTIME_LEASE_MS",
    "29999",
  ],
  [
    "GUEST_JOURNEY_OWNER_RUNTIME_MAX_CLAIMS",
    "0",
  ],
  [
    "GUEST_JOURNEY_OWNER_RUNTIME_RETRY_BASE_MS",
    "999",
  ],
] as const) {
  test(`rejects unsafe ${name}`, () => {
    assert.throws(
      () =>
        resolveGuestJourneyOwnerRuntimeConfig({
          GUEST_JOURNEY_OWNER_RUNTIME_ENABLED:
            "false",
          [name]: value,
        }),
      new RegExp(`${name}_INVALID`)
    );
  });
}

test("rejects ambiguous activation values", () => {
  assert.throws(
    () =>
      resolveGuestJourneyOwnerRuntimeConfig({
        GUEST_JOURNEY_OWNER_RUNTIME_ENABLED:
          "sometimes",
      }),
    /OWNER_RUNTIME_ENABLED_INVALID/
  );
});
