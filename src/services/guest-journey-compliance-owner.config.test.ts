import assert from "node:assert/strict";
import test from "node:test";

import {
  isGuestJourneyComplianceOwnerScope,
  resolveGuestJourneyComplianceOwnerConfig,
} from "./guest-journey-compliance-owner.config";

test("E10 Compliance Owner is default-off", () => {
  const config = resolveGuestJourneyComplianceOwnerConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.batchSize, 20);
  assert.deepEqual(config.organizationIds, []);
  assert.deepEqual(config.propertyIds, []);
  assert.equal(isGuestJourneyComplianceOwnerScope(config, {
    organizationId: "org-1",
    propertyId: "property-1",
  }), false);
});

test("E10 Compliance Owner requires explicit canary scope when enabled", () => {
  assert.throws(
    () => resolveGuestJourneyComplianceOwnerConfig({
      GUEST_JOURNEY_COMPLIANCE_OWNER_EXECUTE: "true",
    }),
    /COMPLIANCE_OWNER_SCOPE_REQUIRED/
  );
});

test("E10 Compliance Owner normalizes canary scope and bounded controls", () => {
  const config = resolveGuestJourneyComplianceOwnerConfig({
    GUEST_JOURNEY_COMPLIANCE_OWNER_EXECUTE: "yes",
    GUEST_JOURNEY_COMPLIANCE_OWNER_ORGANIZATION_IDS: " org-2,org-1,org-2 ",
    GUEST_JOURNEY_COMPLIANCE_OWNER_PROPERTY_IDS: " property-2 ",
    GUEST_JOURNEY_COMPLIANCE_OWNER_BATCH_SIZE: "9",
    GUEST_JOURNEY_COMPLIANCE_OWNER_LEASE_MS: "60000",
    GUEST_JOURNEY_COMPLIANCE_OWNER_MAX_CLAIMS: "4",
    GUEST_JOURNEY_COMPLIANCE_OWNER_RETRY_BASE_MS: "120000",
  });

  assert.equal(config.enabled, true);
  assert.deepEqual(config.organizationIds, ["org-1", "org-2"]);
  assert.deepEqual(config.propertyIds, ["property-2"]);
  assert.equal(config.batchSize, 9);
  assert.equal(config.leaseMs, 60_000);
  assert.equal(config.maxClaims, 4);
  assert.equal(config.retryBaseMs, 120_000);
  assert.equal(isGuestJourneyComplianceOwnerScope(config, {
    organizationId: "org-1",
    propertyId: "property-2",
  }), true);
  assert.equal(isGuestJourneyComplianceOwnerScope(config, {
    organizationId: "org-1",
    propertyId: "property-x",
  }), false);
  assert.equal(isGuestJourneyComplianceOwnerScope(config, {
    organizationId: "org-x",
    propertyId: "property-2",
  }), false);
});

for (const [name, value] of [
  ["GUEST_JOURNEY_COMPLIANCE_OWNER_BATCH_SIZE", "0"],
  ["GUEST_JOURNEY_COMPLIANCE_OWNER_LEASE_MS", "1"],
  ["GUEST_JOURNEY_COMPLIANCE_OWNER_MAX_CLAIMS", "11"],
  ["GUEST_JOURNEY_COMPLIANCE_OWNER_RETRY_BASE_MS", "999"],
] as const) {
  test(`E10 Compliance Owner rejects out-of-range ${name}`, () => {
    assert.throws(
      () => resolveGuestJourneyComplianceOwnerConfig({ [name]: value }),
      /_INVALID/
    );
  });
}
