import assert from "node:assert/strict";
import test from "node:test";

import { resolveChannexAriMapping } from "./channex-ari-mapping.service";

function property(overrides: Record<string, unknown> = {}) {
  return {
    id: "property-1",
    organizationId: "org-1",
    status: "ACTIVE",
    distributionEnabled: true,
    distributionStatus: "ACTIVE",
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "connection-1",
    organizationId: "org-1",
    provider: "CHANNEX",
    status: "ACTIVE",
    ...overrides,
  };
}

function listing(overrides: Record<string, unknown> = {}) {
  return {
    id: "listing-1",
    connectionId: "connection-1",
    propertyId: "property-1",
    externalListingId: "room-type-1",
    metadata: {
      provider: "CHANNEX",
      channexPropertyId: "channex-property-1",
      channexRatePlanId: "rate-plan-1",
    },
    ...overrides,
  };
}

function createDb(input: {
  property?: any;
  connection?: any;
  listings?: any[];
} = {}) {
  const calls: Array<{ model: string; args: unknown }> = [];

  return {
    db: {
      property: {
        findFirst: async (args: unknown) => {
          calls.push({ model: "property", args });
          return input.property === undefined ? property() : input.property;
        },
      },
      pmsConnection: {
        findUnique: async (args: unknown) => {
          calls.push({ model: "connection", args });
          return input.connection === undefined
            ? connection()
            : input.connection;
        },
      },
      pmsListing: {
        findMany: async (args: unknown) => {
          calls.push({ model: "listing", args });
          return input.listings === undefined ? [listing()] : input.listings;
        },
      },
    } as any,
    calls,
  };
}

test("resolves exactly one active tenant mapping using certified V1 metadata", async () => {
  const mock = createDb();

  const result = await resolveChannexAriMapping(mock.db, {
    organizationId: " org-1 ",
    propertyId: " property-1 ",
  });

  assert.deepEqual(result, {
    connectionId: "connection-1",
    listingId: "listing-1",
    connectionProvider: "CHANNEX",
    connectionOrganizationId: "org-1",
    propertyOrganizationId: "org-1",
    propertyId: "property-1",
    externalRoomTypeId: "room-type-1",
    channexPropertyId: "channex-property-1",
    channexRatePlanId: "rate-plan-1",
  });
  assert.deepEqual(mock.calls, [
    {
      model: "property",
      args: {
        where: { id: "property-1", organizationId: "org-1" },
        select: {
          id: true,
          organizationId: true,
          status: true,
          distributionEnabled: true,
          distributionStatus: true,
        },
      },
    },
    {
      model: "connection",
      args: {
        where: {
          organizationId_provider: {
            organizationId: "org-1",
            provider: "CHANNEX",
          },
        },
        select: {
          id: true,
          organizationId: true,
          provider: true,
          status: true,
        },
      },
    },
    {
      model: "listing",
      args: {
        where: {
          connectionId: "connection-1",
          propertyId: "property-1",
        },
        orderBy: { id: "asc" },
        take: 2,
        select: {
          id: true,
          connectionId: true,
          propertyId: true,
          externalListingId: true,
          metadata: true,
        },
      },
    },
  ]);
});

test("rejects missing tenant identifiers before database access", async () => {
  for (const input of [
    { organizationId: "", propertyId: "property-1" },
    { organizationId: "org-1", propertyId: " " },
  ]) {
    const mock = createDb();

    await assert.rejects(
      () => resolveChannexAriMapping(mock.db, input),
      /CHANNEX_ARI_(ORGANIZATION|PROPERTY)_ID_REQUIRED/
    );
    assert.equal(mock.calls.length, 0);
  }
});

test("rejects missing, inactive and undistributed properties before connection lookup", async () => {
  const scenarios: Array<{ value: any; error: RegExp }> = [
    { value: null, error: /CHANNEX_ARI_PROPERTY_NOT_FOUND/ },
    {
      value: property({ status: "ARCHIVED" }),
      error: /CHANNEX_ARI_PROPERTY_NOT_ACTIVE/,
    },
    {
      value: property({ distributionEnabled: false }),
      error: /CHANNEX_ARI_PROPERTY_DISTRIBUTION_NOT_ACTIVE/,
    },
    {
      value: property({ distributionStatus: "FAILED" }),
      error: /CHANNEX_ARI_PROPERTY_DISTRIBUTION_NOT_ACTIVE/,
    },
  ];

  for (const scenario of scenarios) {
    const mock = createDb({ property: scenario.value });

    await assert.rejects(
      () =>
        resolveChannexAriMapping(mock.db, {
          organizationId: "org-1",
          propertyId: "property-1",
        }),
      scenario.error
    );
    assert.deepEqual(mock.calls.map((call) => call.model), ["property"]);
  }
});

test("rejects missing, cross-tenant, wrong-provider and inactive connections", async () => {
  const scenarios: Array<{ value: any; error: RegExp }> = [
    { value: null, error: /CHANNEX_ARI_CONNECTION_NOT_FOUND/ },
    {
      value: connection({ organizationId: "org-2" }),
      error: /CHANNEX_ARI_CONNECTION_TENANT_MISMATCH/,
    },
    {
      value: connection({ provider: "LODGIFY" }),
      error: /CHANNEX_ARI_CONNECTION_TENANT_MISMATCH/,
    },
    {
      value: connection({ status: "DISABLED" }),
      error: /CHANNEX_ARI_CONNECTION_NOT_ACTIVE/,
    },
  ];

  for (const scenario of scenarios) {
    const mock = createDb({ connection: scenario.value });

    await assert.rejects(
      () =>
        resolveChannexAriMapping(mock.db, {
          organizationId: "org-1",
          propertyId: "property-1",
        }),
      scenario.error
    );
    assert.deepEqual(mock.calls.map((call) => call.model), [
      "property",
      "connection",
    ]);
  }
});

test("enforces exactly one listing for the tenant property", async () => {
  for (const scenario of [
    {
      listings: [],
      error: /CHANNEX_ARI_LISTING_MAPPING_MISSING/,
    },
    {
      listings: [listing(), listing({ id: "listing-2" })],
      error: /CHANNEX_ARI_LISTING_MAPPING_CARDINALITY_INVALID/,
    },
    {
      listings: [listing({ propertyId: "property-2" })],
      error: /CHANNEX_ARI_LISTING_TENANT_MISMATCH/,
    },
    {
      listings: [listing({ connectionId: "connection-2" })],
      error: /CHANNEX_ARI_LISTING_TENANT_MISMATCH/,
    },
  ]) {
    const mock = createDb({ listings: scenario.listings });

    await assert.rejects(
      () =>
        resolveChannexAriMapping(mock.db, {
          organizationId: "org-1",
          propertyId: "property-1",
        }),
      scenario.error
    );
  }
});

test("rejects invalid or incomplete Channex listing metadata", async () => {
  const scenarios: Array<{ value: any; error: RegExp }> = [
    {
      value: listing({ metadata: null }),
      error: /CHANNEX_ARI_LISTING_METADATA_INVALID/,
    },
    {
      value: listing({ metadata: [] }),
      error: /CHANNEX_ARI_LISTING_METADATA_INVALID/,
    },
    {
      value: listing({ metadata: {} }),
      error: /CHANNEX_ARI_LISTING_PROVIDER_REQUIRED/,
    },
    {
      value: listing({
        metadata: {
          provider: "LODGIFY",
          channexPropertyId: "channex-property-1",
          channexRatePlanId: "rate-plan-1",
        },
      }),
      error: /CHANNEX_ARI_LISTING_PROVIDER_MISMATCH/,
    },
    {
      value: listing({ externalListingId: " " }),
      error: /CHANNEX_ARI_ROOM_TYPE_MAPPING_MISSING/,
    },
    {
      value: listing({
        metadata: {
          provider: "CHANNEX",
          channexRatePlanId: "rate-plan-1",
        },
      }),
      error: /CHANNEX_ARI_CHANNEX_PROPERTY_MAPPING_MISSING/,
    },
    {
      value: listing({
        metadata: {
          provider: "CHANNEX",
          channexPropertyId: "channex-property-1",
        },
      }),
      error: /CHANNEX_ARI_RATE_PLAN_MAPPING_MISSING/,
    },
  ];

  for (const scenario of scenarios) {
    const mock = createDb({ listings: [scenario.value] });

    await assert.rejects(
      () =>
        resolveChannexAriMapping(mock.db, {
          organizationId: "org-1",
          propertyId: "property-1",
        }),
      scenario.error
    );
  }
});

test("does not mutate listing metadata or expose unrelated metadata fields", async () => {
  const metadata = {
    provider: "CHANNEX",
    channexPropertyId: "channex-property-1",
    channexRatePlanId: "rate-plan-1",
    apiKey: "must-not-be-returned",
    nested: { private: true },
  };
  const before = structuredClone(metadata);
  const mock = createDb({ listings: [listing({ metadata })] });

  const result = await resolveChannexAriMapping(mock.db, {
    organizationId: "org-1",
    propertyId: "property-1",
  });

  assert.deepEqual(metadata, before);
  assert.equal(JSON.stringify(result).includes("must-not-be-returned"), false);
  assert.equal("metadata" in result, false);
});
