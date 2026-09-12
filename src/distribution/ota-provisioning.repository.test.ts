import assert from "node:assert/strict";
import test from "node:test";

import {
  OtaProvisioningRepositoryError,
  PrismaOtaProvisioningRepository,
} from "./ota-provisioning.repository.js";

function setup(record?: any, pmsListings: any[] = []) {
  const reads: any[] = [];
  const groupUpdates: any[] = [];
  const propertyUpdates: any[] = [];
  const pmsUpdates: any[] = [];
  const audits: any[] = [];
  const client = {
    distributionProperty: {
      async findFirst(args: any) { reads.push(args); return record ?? null; },
      async updateMany(args: any) { propertyUpdates.push(args); return { count: 1 }; },
    },
    distributionGroup: {
      async updateMany(args: any) { groupUpdates.push(args); return { count: 1 }; },
    },
    pmsListing: {
      async findMany() { return pmsListings; },
      async updateMany(args: any) { pmsUpdates.push(args); return { count: 1 }; },
    },
    apmsAuditEntry: {
      async create(args: any) { audits.push(args); return { id: "audit-1" }; },
    },
    async $transaction<T>(work: (tx: any) => Promise<T>) { return work(client); },
  };
  return {
    repository: new PrismaOtaProvisioningRepository(client, "usd"),
    reads,
    groupUpdates,
    propertyUpdates,
    pmsUpdates,
    audits,
  };
}

const record = {
  id: "distribution-property-1",
  organizationId: "org-1",
  propertyId: "property-1",
  platform: "CHANNEX",
  provisioningStatus: "FAILED",
  lastErrorCode: "OTA_PROVIDER_REJECTED",
  externalPropertyId: "property-ext",
  externalPrimaryRoomTypeId: "room-ext",
  externalPrimaryRatePlanId: null,
  organization: { name: "Organization One" },
  updatedAt: new Date("2026-09-12T12:00:00.000Z"),
  property: {
    id: "property-1",
    organizationId: "org-1",
    name: "Casa Uno",
    timezone: "America/Puerto_Rico",
  },
  group: {
    id: "group-1",
    organizationId: "org-1",
    platform: "CHANNEX",
    provisioningStatus: "READY",
    lastErrorCode: null,
    externalGroupId: "group-ext",
  },
};

const legacyListing = {
  id: "listing-1",
  connectionId: "pms-connection-1",
  propertyId: "property-1",
  externalListingId: "certified-room",
  metadata: {
    provider: "CHANNEX",
    channexPropertyId: "certified-property",
    channexRatePlanId: "certified-rate",
    preserved: "unchanged",
  },
  updatedAt: new Date("2026-08-20T12:00:00.000Z"),
  connection: {
    id: "pms-connection-1",
    organizationId: "org-1",
    provider: "CHANNEX",
    status: "ACTIVE",
  },
};

test("snapshot query and returned evidence remain tenant scoped", async () => {
  const { repository, reads } = setup(record);
  const snapshot = await repository.loadTenantSnapshot("org-1", "property-1");
  assert.deepEqual(reads[0].where, {
    organizationId: "org-1",
    propertyId: "property-1",
    platform: "CHANNEX",
  });
  assert.equal(snapshot?.currency, "USD");
  assert.equal(snapshot?.externalPropertyId, "property-ext");
  assert.equal(snapshot?.externalPrimaryRoomTypeId, "room-ext");
  assert.equal(snapshot?.externalPrimaryRatePlanId, null);
  assert.equal(snapshot?.propertyLastErrorCode, "OTA_PROVIDER_REJECTED");
});

test("cross-tenant group evidence fails closed", async () => {
  const { repository } = setup({ ...record, group: { ...record.group, organizationId: "org-other" } });
  await assert.rejects(
    repository.loadTenantSnapshot("org-1", "property-1"),
    /OTA_DISTRIBUTION_TENANT_MISMATCH/
  );
});

test("claims and checkpoints use exact tenant, platform and state fences", async () => {
  const { repository, groupUpdates, propertyUpdates } = setup(record);
  assert.equal(await repository.claimGroup("org-1", "group-1"), true);
  assert.equal(await repository.claimProperty("org-1", "distribution-property-1"), true);
  await repository.checkpointProperty("org-1", "distribution-property-1", "property-ext");
  await repository.checkpointPrimaryRoomType("org-1", "distribution-property-1", "room-ext");

  assert.deepEqual(groupUpdates[0].where.provisioningStatus, { in: ["NOT_PROVISIONED", "FAILED"] });
  assert.equal(groupUpdates[0].where.organizationId, "org-1");
  assert.deepEqual(propertyUpdates[0].where.provisioningStatus, { in: ["NOT_PROVISIONED", "FAILED"] });
  assert.deepEqual(propertyUpdates[1].data, { externalPropertyId: "property-ext" });
  assert.deepEqual(propertyUpdates[2].data, { externalPrimaryRoomTypeId: "room-ext" });
});

test("invalid currency is rejected before database access", () => {
  assert.throws(
    () => new PrismaOtaProvisioningRepository(setup(record).repository as any, "US dollars"),
    (error: unknown) =>
      error instanceof OtaProvisioningRepositoryError &&
      error.code === "OTA_DEFAULT_CURRENCY_INVALID"
  );
});

const readyDistributionRecord = {
  ...record,
  provisioningStatus: "READY",
  externalPropertyId: "canonical-property",
  externalPrimaryRoomTypeId: "canonical-room",
  externalPrimaryRatePlanId: "canonical-rate",
};

test("aligns the unique PMS listing to the READY DistributionProperty without changing distribution", async () => {
  const { repository, propertyUpdates, pmsUpdates, audits } = setup(
    readyDistributionRecord,
    [legacyListing]
  );
  const result = await repository.alignPmsListingToReadyDistributionMapping(
    "org-1",
    "property-1",
    "user-1",
    new Date("2026-09-12T13:00:00.000Z")
  );
  assert.equal(result, "ALIGNED");
  assert.equal(propertyUpdates.length, 0);
  assert.deepEqual(pmsUpdates[0].where, {
    id: "listing-1",
    connectionId: "pms-connection-1",
    propertyId: "property-1",
    externalListingId: "certified-room",
    updatedAt: new Date("2026-08-20T12:00:00.000Z"),
    connection: {
      organizationId: "org-1",
      provider: "CHANNEX",
      status: "ACTIVE",
    },
  });
  assert.deepEqual(pmsUpdates[0].data, {
    externalListingId: "canonical-room",
    metadata: {
      provider: "CHANNEX",
      channexPropertyId: "canonical-property",
      channexRatePlanId: "canonical-rate",
      preserved: "unchanged",
    },
  });
  assert.equal(audits.length, 1);
  assert.equal(
    audits[0].data.eventType,
    "PMS_LISTING_ALIGNED_TO_DISTRIBUTION_MAPPING"
  );
  assert.equal(audits[0].data.completedAt.toISOString(), "2026-09-12T13:00:00.000Z");
  assert.deepEqual(audits[0].data.metadata.canonical, {
    externalPropertyId: "canonical-property",
    externalPrimaryRoomTypeId: "canonical-room",
    externalPrimaryRatePlanId: "canonical-rate",
  });
});

test("an already aligned PMS mapping is idempotent", async () => {
  const alignedListing = {
    ...legacyListing,
    externalListingId: "canonical-room",
    metadata: {
      ...legacyListing.metadata,
      channexPropertyId: "canonical-property",
      channexRatePlanId: "canonical-rate",
    },
  };
  const { repository, propertyUpdates, pmsUpdates, audits } = setup(
    readyDistributionRecord,
    [alignedListing]
  );
  assert.equal(
    await repository.alignPmsListingToReadyDistributionMapping(
      "org-1",
      "property-1",
      "user-1",
      new Date()
    ),
    "ALREADY_ALIGNED"
  );
  assert.equal(propertyUpdates.length, 0);
  assert.equal(pmsUpdates.length, 0);
  assert.equal(audits.length, 0);
});

test("PMS alignment fails closed for zero, multiple, foreign-tenant, and invalid metadata listings", async (t) => {
  const scenarios = [
    { name: "zero", listings: [], code: "OTA_CERTIFIED_PMS_LISTING_CARDINALITY_INVALID" },
    { name: "multiple", listings: [legacyListing, { ...legacyListing, id: "listing-2" }], code: "OTA_CERTIFIED_PMS_LISTING_CARDINALITY_INVALID" },
    { name: "foreign tenant", listings: [{ ...legacyListing, connection: { ...legacyListing.connection, organizationId: "org-2" } }], code: "OTA_DISTRIBUTION_TENANT_MISMATCH" },
    { name: "invalid metadata", listings: [{ ...legacyListing, metadata: [] }], code: "OTA_CERTIFIED_PMS_LISTING_METADATA_INVALID" },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { repository, propertyUpdates, pmsUpdates, audits } = setup(
        readyDistributionRecord,
        scenario.listings
      );
      await assert.rejects(
        repository.alignPmsListingToReadyDistributionMapping("org-1", "property-1", "user-1", new Date()),
        (error: unknown) =>
          error instanceof OtaProvisioningRepositoryError && error.code === scenario.code
      );
      assert.equal(propertyUpdates.length, 0);
      assert.equal(pmsUpdates.length, 0);
      assert.equal(audits.length, 0);
    });
  }
});

test("PMS alignment rejects a non-ready distribution mapping before any listing write", async () => {
  const { repository, pmsUpdates, audits } = setup(record, [legacyListing]);
  await assert.rejects(
    repository.alignPmsListingToReadyDistributionMapping(
      "org-1",
      "property-1",
      "user-1",
      new Date()
    ),
    (error: unknown) =>
      error instanceof OtaProvisioningRepositoryError &&
      error.code === "OTA_DISTRIBUTION_MAPPING_NOT_READY"
  );
  assert.equal(pmsUpdates.length, 0);
  assert.equal(audits.length, 0);
});
