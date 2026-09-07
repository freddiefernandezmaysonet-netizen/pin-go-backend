import assert from "node:assert/strict";
import test from "node:test";

import {
  CanonicalOtaReadinessServiceError,
  reconcileCanonicalOtaReadiness,
} from "./channex-canonical-readiness.service.js";

function fixture(options: { lifecycle?: string; tenantMismatch?: boolean } = {}) {
  const updates: any[] = [];
  const audits: any[] = [];
  const client = {
    distributionProperty: {
      async findFirst() {
        return {
          id: "dp-1",
          organizationId: "org-1",
          propertyId: "prop-1",
          externalPropertyId: "ext-prop",
          externalPrimaryRoomTypeId: "ext-room",
          externalPrimaryRatePlanId: "ext-rate",
        };
      },
    },
    otaChannelConnection: {
      async findFirst() {
        return {
          id: "conn-1",
          organizationId: options.tenantMismatch ? "other-org" : "org-1",
          propertyId: "prop-1",
          distributionPropertyId: "dp-1",
          provider: "AIRBNB" as const,
          externalConnectionId: "ext-channel",
          externalChannelCode: "ABB",
        };
      },
      async updateMany(args: any) { updates.push(args); return { count: 1 }; },
    },
    apmsAuditEntry: {
      async findFirst() { return { reason: options.lifecycle ?? "activate_channel" }; },
      async create(args: any) { audits.push(args); return { id: "audit" }; },
    },
  };
  const transport = {
    async getProperty() { return { data: { id: "ext-prop", attributes: { acc_channels_count: 1 } } }; },
    async listRoomTypes() { return { data: [{ id: "ext-room" }] }; },
    async listRatePlans() { return { data: [{ id: "ext-rate" }] }; },
  };
  return { client, transport, updates, audits };
}

test("persists READY only after canonical read-only evidence", async () => {
  const f = fixture();
  const result = await reconcileCanonicalOtaReadiness({
    client: f.client,
    transport: f.transport,
    organizationId: "org-1",
    propertyId: "prop-1",
    provider: "AIRBNB",
    now: new Date("2026-09-07T01:00:00.000Z"),
  });
  assert.equal(result.authorizationReadiness, "READY");
  assert.equal(result.mappingReadiness, "READY");
  assert.equal(result.distributionReadiness, "READY");
  assert.equal(f.updates[0].data.distributionReadiness, "READY");
  assert.equal(f.audits.length, 1);
});

test("deactivate lifecycle remains BLOCKED after canonical inventory reads", async () => {
  const f = fixture({ lifecycle: "deactivate_channel" });
  const result = await reconcileCanonicalOtaReadiness({
    client: f.client,
    transport: f.transport,
    organizationId: "org-1",
    propertyId: "prop-1",
    provider: "AIRBNB",
  });
  assert.equal(result.distributionReadiness, "BLOCKED");
  assert.equal(f.updates[0].data.distributionReadiness, "BLOCKED");
});

test("tenant mismatch fails before provider reads or state mutation", async () => {
  const f = fixture({ tenantMismatch: true });
  let reads = 0;
  const transport = {
    async getProperty() { reads += 1; return {}; },
    async listRoomTypes() { reads += 1; return {}; },
    async listRatePlans() { reads += 1; return {}; },
  };
  await assert.rejects(
    reconcileCanonicalOtaReadiness({
      client: f.client,
      transport,
      organizationId: "org-1",
      propertyId: "prop-1",
      provider: "AIRBNB",
    }),
    (e: unknown) => e instanceof CanonicalOtaReadinessServiceError && e.code === "OTA_DISTRIBUTION_TENANT_MISMATCH"
  );
  assert.equal(reads, 0);
  assert.equal(f.updates.length, 0);
});
