import assert from "node:assert/strict";
import test from "node:test";

import {
  GUEST_JOURNEY_ACCESS_PROVISION_LEAD_MS,
  isGuestJourneyAccessOwnerScope,
  resolveGuestJourneyAccessOwnerConfig,
} from "./guest-journey-access-owner.config";

test("E8 is fail-closed, scoped, and preserves the two-hour access window", () => {
  const config = resolveGuestJourneyAccessOwnerConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.provisionLeadMs, 2 * 60 * 60 * 1000);
  assert.equal(config.provisionLeadMs, GUEST_JOURNEY_ACCESS_PROVISION_LEAD_MS);
  assert.equal(isGuestJourneyAccessOwnerScope(config, {
    organizationId: "org-1",
    propertyId: "property-1",
  }), false);
});

test("E8 requires an explicit tenant canary when enabled", () => {
  assert.throws(
    () => resolveGuestJourneyAccessOwnerConfig({
      GUEST_JOURNEY_ACCESS_OWNER_EXECUTE: "true",
    }),
    /ACCESS_OWNER_SCOPE_REQUIRED/
  );
});

test("E8 normalizes canary scope and bounded execution controls", () => {
  const config = resolveGuestJourneyAccessOwnerConfig({
    GUEST_JOURNEY_ACCESS_OWNER_EXECUTE: "yes",
    GUEST_JOURNEY_ACCESS_OWNER_ORGANIZATION_IDS: " org-2,org-1,org-2 ",
    GUEST_JOURNEY_ACCESS_OWNER_PROPERTY_IDS: " property-2 ",
    GUEST_JOURNEY_ACCESS_OWNER_BATCH_SIZE: "9",
    GUEST_JOURNEY_ACCESS_OWNER_LEASE_MS: "60000",
    GUEST_JOURNEY_ACCESS_OWNER_MAX_CLAIMS: "7",
    GUEST_JOURNEY_ACCESS_OWNER_RETRY_BASE_MS: "120000",
    GUEST_JOURNEY_ACCESS_OWNER_PROVIDER_TIMEOUT_MS: "45000",
  });
  assert.deepEqual(config.organizationIds, ["org-1", "org-2"]);
  assert.deepEqual(config.propertyIds, ["property-2"]);
  assert.equal(config.batchSize, 9);
  assert.equal(config.leaseMs, 60_000);
  assert.equal(config.maxClaims, 7);
  assert.equal(config.retryBaseMs, 120_000);
  assert.equal(config.providerTimeoutMs, 45_000);
  assert.equal(isGuestJourneyAccessOwnerScope(config, {
    organizationId: "org-1",
    propertyId: "property-2",
  }), true);
  assert.equal(isGuestJourneyAccessOwnerScope(config, {
    propertyId: "other-property",
  }), false);
});

for (const [name, value] of [
  ["GUEST_JOURNEY_ACCESS_OWNER_BATCH_SIZE", "0"],
  ["GUEST_JOURNEY_ACCESS_OWNER_LEASE_MS", "1"],
  ["GUEST_JOURNEY_ACCESS_OWNER_MAX_CLAIMS", "11"],
  ["GUEST_JOURNEY_ACCESS_OWNER_RETRY_BASE_MS", "999"],
  ["GUEST_JOURNEY_ACCESS_OWNER_PROVIDER_TIMEOUT_MS", "121000"],
] as const) {
  test(`E8 rejects unsafe ${name}`, () => {
    assert.throws(
      () => resolveGuestJourneyAccessOwnerConfig({ [name]: value }),
      new RegExp(`${name}_INVALID`)
    );
  });
}

test("E8 rejects ambiguous activation values", () => {
  assert.throws(
    () => resolveGuestJourneyAccessOwnerConfig({
      GUEST_JOURNEY_ACCESS_OWNER_EXECUTE: "sometimes",
    }),
    /ACCESS_OWNER_EXECUTE_INVALID/
  );
});
