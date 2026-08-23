import assert from "node:assert/strict";
import test from "node:test";

import {
  isGuestJourneyCommunicationsOwnerScope,
  resolveGuestJourneyCommunicationsOwnerConfig,
} from "./guest-journey-communications-owner.config";

test("E7 is fail-closed and off by default", () => {
  assert.deepEqual(resolveGuestJourneyCommunicationsOwnerConfig({}), {
    enabled: false,
    batchSize: 20,
    leaseMs: 60_000,
    maxClaims: 3,
    retryBaseMs: 30_000,
    providerTimeoutMs: 15_000,
    organizationIds: [],
    propertyIds: [],
  });
});

test("E7 requires an explicit tenant canary when enabled", () => {
  assert.throws(
    () => resolveGuestJourneyCommunicationsOwnerConfig({
      GUEST_JOURNEY_COMMUNICATIONS_EXECUTE: "true",
    }),
    /COMMUNICATIONS_SCOPE_REQUIRED/
  );
});

test("E7 parses bounded execution controls and deduplicates scope", () => {
  assert.deepEqual(resolveGuestJourneyCommunicationsOwnerConfig({
    GUEST_JOURNEY_COMMUNICATIONS_EXECUTE: "1",
    GUEST_JOURNEY_COMMUNICATIONS_ORGANIZATION_IDS: "org-b,org-a,org-b",
    GUEST_JOURNEY_COMMUNICATIONS_PROPERTY_IDS: "property-1",
    GUEST_JOURNEY_COMMUNICATIONS_BATCH_SIZE: "9",
    GUEST_JOURNEY_COMMUNICATIONS_LEASE_MS: "45000",
    GUEST_JOURNEY_COMMUNICATIONS_MAX_CLAIMS: "4",
    GUEST_JOURNEY_COMMUNICATIONS_RETRY_BASE_MS: "5000",
    GUEST_JOURNEY_COMMUNICATIONS_PROVIDER_TIMEOUT_MS: "12000",
  }), {
    enabled: true,
    batchSize: 9,
    leaseMs: 45_000,
    maxClaims: 4,
    retryBaseMs: 5_000,
    providerTimeoutMs: 12_000,
    organizationIds: ["org-a", "org-b"],
    propertyIds: ["property-1"],
  });
});

test("E7 rejects malformed activation and unsafe numeric limits", () => {
  assert.throws(
    () => resolveGuestJourneyCommunicationsOwnerConfig({
      GUEST_JOURNEY_COMMUNICATIONS_EXECUTE: "sometimes",
    }),
    /COMMUNICATIONS_EXECUTE_INVALID/
  );
  assert.throws(
    () => resolveGuestJourneyCommunicationsOwnerConfig({
      GUEST_JOURNEY_COMMUNICATIONS_BATCH_SIZE: "101",
    }),
    /COMMUNICATIONS_BATCH_SIZE_INVALID/
  );
});

test("the legacy retry worker yields only typed messages inside the active E7 canary", () => {
  const active = resolveGuestJourneyCommunicationsOwnerConfig({
    GUEST_JOURNEY_COMMUNICATIONS_EXECUTE: "true",
    GUEST_JOURNEY_COMMUNICATIONS_ORGANIZATION_IDS: "org-1",
  });
  assert.equal(isGuestJourneyCommunicationsOwnerScope(active, {
    organizationId: "org-1",
    propertyId: "property-1",
    communicationType: "PRECHECKIN",
  }), true);
  assert.equal(isGuestJourneyCommunicationsOwnerScope(active, {
    organizationId: "org-2",
    propertyId: "property-2",
    communicationType: "PRECHECKIN",
  }), false);
  assert.equal(isGuestJourneyCommunicationsOwnerScope(active, {
    organizationId: "org-1",
    propertyId: "property-1",
    communicationType: null,
  }), false);
  assert.equal(isGuestJourneyCommunicationsOwnerScope({ ...active, enabled: false }, {
    organizationId: "org-1",
    communicationType: "PRECHECKIN",
  }), false);
});
