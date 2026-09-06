import assert from "node:assert/strict";
import test from "node:test";

import {
  OtaProvisioningRepositoryError,
  PrismaOtaProvisioningRepository,
} from "./ota-provisioning.repository.js";

function setup(record?: any) {
  const reads: any[] = [];
  const groupUpdates: any[] = [];
  const propertyUpdates: any[] = [];
  const client = {
    distributionProperty: {
      async findFirst(args: any) { reads.push(args); return record ?? null; },
      async updateMany(args: any) { propertyUpdates.push(args); return { count: 1 }; },
    },
    distributionGroup: {
      async updateMany(args: any) { groupUpdates.push(args); return { count: 1 }; },
    },
  };
  return {
    repository: new PrismaOtaProvisioningRepository(client, "usd"),
    reads,
    groupUpdates,
    propertyUpdates,
  };
}

const record = {
  id: "distribution-property-1",
  organizationId: "org-1",
  propertyId: "property-1",
  provisioningStatus: "FAILED",
  lastErrorCode: "OTA_PROVIDER_REJECTED",
  externalPropertyId: "property-ext",
  externalPrimaryRoomTypeId: "room-ext",
  externalPrimaryRatePlanId: null,
  organization: { name: "Organization One" },
  property: { name: "Casa Uno", timezone: "America/Puerto_Rico" },
  group: {
    id: "group-1",
    organizationId: "org-1",
    provisioningStatus: "READY",
    lastErrorCode: null,
    externalGroupId: "group-ext",
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
