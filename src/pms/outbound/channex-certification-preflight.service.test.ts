import assert from "node:assert/strict";
import test from "node:test";

import { runChannexCertificationPreflight } from "./channex-certification-preflight.service";

const manifest = {
  organizationId: "certification-org",
  propertyId: "certification-property",
  channexPropertyId: "certification-channex-property",
  channexRoomTypeId: "31a7161d-cd47-4f38-b5f4-4b9e11d4e6f9",
  channexRatePlanId: "certification-rate-plan",
  connectionId: "certification-connection",
  listingId: "certification-listing",
};

function mapping(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: manifest.connectionId,
    listingId: manifest.listingId,
    connectionProvider: "CHANNEX",
    connectionOrganizationId: manifest.organizationId,
    propertyOrganizationId: manifest.organizationId,
    propertyId: manifest.propertyId,
    externalRoomTypeId: manifest.channexRoomTypeId,
    channexPropertyId: manifest.channexPropertyId,
    channexRatePlanId: manifest.channexRatePlanId,
    ...overrides,
  };
}

test("preflight resolves and approves only the exact certification mapping", async () => {
  const calls: any[] = [];

  const result = await runChannexCertificationPreflight({
    db: { name: "db" } as any,
    manifest,
    resolveMapping: (async (db: any, input: any) => {
      calls.push({ db, input });
      return mapping();
    }) as any,
  });

  assert.deepEqual(calls, [
    {
      db: { name: "db" },
      input: {
        organizationId: manifest.organizationId,
        propertyId: manifest.propertyId,
      },
    },
  ]);
  assert.deepEqual(result, {
    ok: true,
    manifest,
    mapping: mapping(),
  });
  assert.equal(Object.isFrozen(result.manifest), true);
});

test("preflight aborts when the resolved room type differs from the manifest", async () => {
  await assert.rejects(
    () =>
      runChannexCertificationPreflight({
        db: {} as any,
        manifest,
        resolveMapping: (async () =>
          mapping({
            externalRoomTypeId: "6d6137e5-dcd7-46d5-9df7-b2f8da0ff75a",
          })) as any,
      }),
    /CHANNEX_CERTIFICATION_EXTERNALROOMTYPEID_MISMATCH/
  );
});

test("preflight rejects an incomplete manifest before database access", async () => {
  let resolveCount = 0;

  await assert.rejects(
    () =>
      runChannexCertificationPreflight({
        db: {} as any,
        manifest: { ...manifest, listingId: " " },
        resolveMapping: (async () => {
          resolveCount += 1;
          return mapping();
        }) as any,
      }),
    /CHANNEX_CERTIFICATION_MANIFEST_LISTINGID_REQUIRED/
  );
  assert.equal(resolveCount, 0);
});
