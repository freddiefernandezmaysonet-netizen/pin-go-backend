import assert from "node:assert/strict";
import test from "node:test";

import {
  OtaDistributionPersistenceError,
  prepareOtaDistributionConnection,
  type OtaDistributionPersistenceClient,
} from "./ota-distribution-persistence.service.js";

function createClient(overrides: { actor?: boolean; property?: boolean; corrupt?: boolean } = {}) {
  const writes: Array<{ model: string; args: any }> = [];
  const group = { id: "group-1", organizationId: "org-1", platform: "CHANNEX" as const };
  const distributionProperty = {
    id: "dp-1",
    organizationId: overrides.corrupt ? "org-other" : "org-1",
    propertyId: "property-1",
    groupId: "group-1",
    platform: "CHANNEX" as const,
  };
  const connection = {
    id: "connection-1",
    organizationId: "org-1",
    propertyId: "property-1",
    distributionPropertyId: "dp-1",
    provider: "AIRBNB" as const,
    status: "NOT_CONNECTED",
  };
  const tx = {
    distributionGroup: {
      async upsert(args: unknown) { writes.push({ model: "group", args }); return group; },
    },
    distributionProperty: {
      async findUnique() { return null; },
      async create(args: unknown) { writes.push({ model: "property", args }); return distributionProperty; },
    },
    otaChannelConnection: {
      async findUnique() { return null; },
      async create(args: unknown) { writes.push({ model: "connection", args }); return connection; },
    },
    apmsAuditEntry: {
      async findUnique() { return null; },
      async create(args: unknown) { writes.push({ model: "audit", args }); return {}; },
    },
  };
  const client: OtaDistributionPersistenceClient = {
    dashboardUser: { async findFirst() { return overrides.actor === false ? null : { id: "user-1" }; } },
    property: { async findFirst() { return overrides.property === false ? null : { id: "property-1", organizationId: "org-1" }; } },
    async $transaction(work) { return work(tx); },
  };
  return { client, writes };
}

const base = {
  organizationId: "org-1",
  propertyId: "property-1",
  requestedByUserId: "user-1",
  provider: "AIRBNB" as const,
  requestKey: "request-1",
  now: new Date("2026-09-05T19:00:00.000Z"),
};

test("first OTA request creates only the tenant-scoped logical skeleton", async () => {
  const { client, writes } = createClient();
  const result = await prepareOtaDistributionConnection({ client, ...base });

  assert.equal(result.status, "NOT_CONNECTED");
  assert.deepEqual(writes.map((write) => write.model), ["group", "property", "connection", "audit"]);
  const serialized = JSON.stringify(writes);
  assert.equal(serialized.includes("directBooking"), false);
  assert.equal(serialized.includes("externalGroupId"), false);
  assert.equal(serialized.includes("externalPropertyId"), false);
  assert.match(serialized, /"provisioningTriggered":false/);
});

test("actor and property tenant scope are checked before any transaction writes", async () => {
  for (const overrides of [{ actor: false }, { property: false }]) {
    const { client, writes } = createClient(overrides);
    await assert.rejects(
      prepareOtaDistributionConnection({ client, ...base }),
      OtaDistributionPersistenceError
    );
    assert.deepEqual(writes, []);
  }
});

test("corrupt cross-tenant persistence fails closed inside the transaction", async () => {
  const { client } = createClient({ corrupt: true });
  await assert.rejects(
    prepareOtaDistributionConnection({ client, ...base }),
    /OTA_DISTRIBUTION_TENANT_MISMATCH/
  );
});

test("planned and assisted channels cannot enter self-service", async () => {
  for (const provider of ["EXPEDIA", "VRBO"] as const) {
    const { client, writes } = createClient();
    await assert.rejects(
      prepareOtaDistributionConnection({ client, ...base, provider }),
      /OTA_PROVIDER_SELF_SERVICE_UNAVAILABLE/
    );
    assert.deepEqual(writes, []);
  }
});
