import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertFullSyncCanonicalMappingConsistency,
  assertFullSyncProductionChannexHost,
  resolveFullSyncTodayDateKey,
} from "./dashboard.channex-full-sync.route";

const SAME_INSTANT = new Date("2026-08-21T02:00:00.000Z");

test("Full Sync derives today from the Puerto Rico property timezone", () => {
  assert.equal(
    resolveFullSyncTodayDateKey(SAME_INSTANT, "America/Puerto_Rico"),
    "2026-08-20"
  );
});

test("Full Sync derives today independently from a positive-offset property timezone", () => {
  assert.equal(
    resolveFullSyncTodayDateKey(SAME_INSTANT, "Europe/Madrid"),
    "2026-08-21"
  );
});

test("Full Sync fails closed when property timezone is missing", () => {
  assert.throws(
    () => resolveFullSyncTodayDateKey(SAME_INSTANT, null),
    /PROPERTY_TIMEZONE_REQUIRED/
  );
});

test("Full Sync fails closed when property timezone is invalid", () => {
  assert.throws(
    () => resolveFullSyncTodayDateKey(SAME_INSTANT, "Not/A_Timezone"),
    /PROPERTY_TIMEZONE_INVALID/
  );
});

test("production Full Sync accepts only app.channex.io", () => {
  assert.doesNotThrow(() =>
    assertFullSyncProductionChannexHost({
      NODE_ENV: "production",
      CHANNEX_API_BASE_URL: "https://app.channex.io",
    })
  );
  assert.doesNotThrow(() =>
    assertFullSyncProductionChannexHost({
      NODE_ENV: "production",
      CHANNEX_API_BASE_URL: "https://app.channex.io/",
    })
  );
});

test("production Full Sync rejects staging, missing, and non-canonical Channex hosts", () => {
  for (const value of [
    undefined,
    "https://staging.channex.io",
    "https://api.channex.io",
    "https://app.channex.io/api/v1",
    "https://app.channex.io?target=staging",
  ]) {
    assert.throws(
      () =>
        assertFullSyncProductionChannexHost({
          NODE_ENV: "production",
          CHANNEX_API_BASE_URL: value,
        }),
      /CHANNEX_ARI_PRODUCTION_HOST_INVALID/
    );
  }
});

test("non-production Full Sync leaves environment selection to its explicit runtime", () => {
  assert.doesNotThrow(() =>
    assertFullSyncProductionChannexHost({
      NODE_ENV: "test",
      CHANNEX_API_BASE_URL: "https://staging.channex.io",
    })
  );
});

const LEGACY_MAPPING = {
  channexPropertyId: "property-production",
  externalRoomTypeId: "room-production",
  channexRatePlanId: "rate-production",
};

function canonicalMapping(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: "org-1",
    propertyId: "property-1",
    platform: "CHANNEX",
    provisioningStatus: "READY",
    externalPropertyId: "property-production",
    externalPrimaryRoomTypeId: "room-production",
    externalPrimaryRatePlanId: "rate-production",
    ...overrides,
  };
}

test("Full Sync accepts an aligned READY canonical mapping", () => {
  assert.doesNotThrow(() =>
    assertFullSyncCanonicalMappingConsistency({
      organizationId: "org-1",
      propertyId: "property-1",
      legacyMapping: LEGACY_MAPPING,
      canonicalMapping: canonicalMapping(),
    })
  );
});

test("Full Sync rejects a missing or non-ready canonical mapping", () => {
  assert.throws(
    () =>
      assertFullSyncCanonicalMappingConsistency({
        organizationId: "org-1",
        propertyId: "property-1",
        legacyMapping: LEGACY_MAPPING,
        canonicalMapping: null,
      }),
    /CHANNEX_ARI_CANONICAL_MAPPING_MISSING/
  );
  assert.throws(
    () =>
      assertFullSyncCanonicalMappingConsistency({
        organizationId: "org-1",
        propertyId: "property-1",
        legacyMapping: LEGACY_MAPPING,
        canonicalMapping: canonicalMapping({ provisioningStatus: "FAILED" }),
      }),
    /CHANNEX_ARI_CANONICAL_MAPPING_NOT_READY/
  );
});

test("Full Sync rejects divergence in every canonical Channex identifier", () => {
  for (const overrides of [
    { externalPropertyId: "property-staging" },
    { externalPrimaryRoomTypeId: "room-staging" },
    { externalPrimaryRatePlanId: "rate-staging" },
  ]) {
    assert.throws(
      () =>
        assertFullSyncCanonicalMappingConsistency({
          organizationId: "org-1",
          propertyId: "property-1",
          legacyMapping: LEGACY_MAPPING,
          canonicalMapping: canonicalMapping(overrides),
        }),
      /CHANNEX_ARI_CANONICAL_MAPPING_MISMATCH/
    );
  }
});

test("Full Sync runs production and canonical mapping guards before enqueueing", () => {
  const source = readFileSync(
    new URL("./dashboard.channex-full-sync.route.ts", import.meta.url),
    "utf8"
  );
  const hostGuard = source.indexOf(
    "        assertFullSyncProductionChannexHost();"
  );
  const mappingGuard = source.indexOf(
    "            assertFullSyncCanonicalMappingConsistency({"
  );
  const firstEnqueue = source.indexOf(
    "            await createChannexAriOutboxEvent"
  );

  assert.ok(hostGuard >= 0);
  assert.ok(mappingGuard > hostGuard);
  assert.ok(firstEnqueue > mappingGuard);
});
