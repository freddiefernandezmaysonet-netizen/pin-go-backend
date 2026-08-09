import assert from "node:assert/strict";
import test from "node:test";

import {
  assertChannexCertificationMapping,
  normalizeChannexCertificationManifest,
} from "./channex-certification-manifest.policy";

const manifest = {
  organizationId: "certification-org",
  propertyId: "certification-property",
  channexPropertyId: "certification-channex-property",
  channexRoomTypeId: "31a7161d-cd47-4f38-b5f4-4b9e11d4e6f9",
  channexRatePlanId: "certification-rate-plan",
  connectionId: "certification-connection",
  listingId: "certification-listing",
};

test("normalizes one immutable certification manifest with all required IDs", () => {
  const normalized = normalizeChannexCertificationManifest({
    ...manifest,
    organizationId: ` ${manifest.organizationId} `,
  });

  assert.deepEqual(normalized, manifest);
  assert.equal(Object.isFrozen(normalized), true);
});

test("preflight accepts only the exact frozen certification mapping", () => {
  assert.deepEqual(
    assertChannexCertificationMapping({
      manifest,
      actual: {
        organizationId: manifest.organizationId,
        propertyId: manifest.propertyId,
        channexPropertyId: manifest.channexPropertyId,
        externalRoomTypeId: manifest.channexRoomTypeId,
        channexRatePlanId: manifest.channexRatePlanId,
        connectionId: manifest.connectionId,
        listingId: manifest.listingId,
      },
    }),
    manifest
  );
});

test("preflight aborts on every possible certification ID mismatch", () => {
  const actual = {
    organizationId: manifest.organizationId,
    propertyId: manifest.propertyId,
    channexPropertyId: manifest.channexPropertyId,
    externalRoomTypeId: manifest.channexRoomTypeId,
    channexRatePlanId: manifest.channexRatePlanId,
    connectionId: manifest.connectionId,
    listingId: manifest.listingId,
  };

  for (const field of Object.keys(actual)) {
    assert.throws(
      () =>
        assertChannexCertificationMapping({
          manifest,
          actual: { ...actual, [field]: `wrong-${field}` },
        }),
      new RegExp(`CHANNEX_CERTIFICATION_${field.toUpperCase()}_MISMATCH`)
    );
  }
});

test("rejects incomplete manifests before certification preflight", () => {
  for (const field of Object.keys(manifest)) {
    assert.throws(
      () =>
        normalizeChannexCertificationManifest({
          ...manifest,
          [field]: " ",
        }),
      /CHANNEX_CERTIFICATION_MANIFEST_.*_REQUIRED/
    );
  }
});
