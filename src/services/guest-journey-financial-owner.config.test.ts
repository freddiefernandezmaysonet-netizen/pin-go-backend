import assert from "node:assert/strict";
import test from "node:test";

import {
  isGuestJourneyFinancialOwnerScope,
  resolveGuestJourneyFinancialOwnerConfig,
} from "./guest-journey-financial-owner.config";

test("E9 Financial Owner is fail-closed by default", () => {
  const config = resolveGuestJourneyFinancialOwnerConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.batchSize, 20);
  assert.equal(isGuestJourneyFinancialOwnerScope(config, {
    organizationId: "org-1",
    propertyId: "property-1",
  }), false);
});

test("E9 Financial Owner requires explicit tenant canary scope when enabled", () => {
  assert.throws(
    () => resolveGuestJourneyFinancialOwnerConfig({
      GUEST_JOURNEY_FINANCIAL_OWNER_EXECUTE: "true",
    }),
    /FINANCIAL_OWNER_SCOPE_REQUIRED/
  );
});

test("E9 Financial Owner normalizes canary scope and bounded controls", () => {
  const config = resolveGuestJourneyFinancialOwnerConfig({
    GUEST_JOURNEY_FINANCIAL_OWNER_EXECUTE: "yes",
    GUEST_JOURNEY_FINANCIAL_OWNER_ORGANIZATION_IDS: " org-2,org-1,org-2 ",
    GUEST_JOURNEY_FINANCIAL_OWNER_PROPERTY_IDS: " property-2 ",
    GUEST_JOURNEY_FINANCIAL_OWNER_BATCH_SIZE: "9",
    GUEST_JOURNEY_FINANCIAL_OWNER_LEASE_MS: "60000",
    GUEST_JOURNEY_FINANCIAL_OWNER_MAX_CLAIMS: "4",
    GUEST_JOURNEY_FINANCIAL_OWNER_RETRY_BASE_MS: "120000",
  });
  assert.deepEqual(config.organizationIds, ["org-1", "org-2"]);
  assert.deepEqual(config.propertyIds, ["property-2"]);
  assert.equal(config.batchSize, 9);
  assert.equal(config.leaseMs, 60_000);
  assert.equal(config.maxClaims, 4);
  assert.equal(config.retryBaseMs, 120_000);
  assert.equal(isGuestJourneyFinancialOwnerScope(config, {
    organizationId: "org-1",
    propertyId: "property-2",
  }), true);
  assert.equal(isGuestJourneyFinancialOwnerScope(config, {
    propertyId: "other-property",
  }), false);
});

for (const [name, value] of [
  ["GUEST_JOURNEY_FINANCIAL_OWNER_BATCH_SIZE", "0"],
  ["GUEST_JOURNEY_FINANCIAL_OWNER_LEASE_MS", "1"],
  ["GUEST_JOURNEY_FINANCIAL_OWNER_MAX_CLAIMS", "11"],
  ["GUEST_JOURNEY_FINANCIAL_OWNER_RETRY_BASE_MS", "999"],
] as const) {
  test(`E9 Financial Owner rejects unsafe ${name}`, () => {
    assert.throws(
      () => resolveGuestJourneyFinancialOwnerConfig({ [name]: value }),
      new RegExp(`${name}_INVALID`)
    );
  });
}

test("E9 Financial Owner rejects ambiguous activation values", () => {
  assert.throws(
    () => resolveGuestJourneyFinancialOwnerConfig({
      GUEST_JOURNEY_FINANCIAL_OWNER_EXECUTE: "sometimes",
    }),
    /FINANCIAL_OWNER_EXECUTE_INVALID/
  );
});
