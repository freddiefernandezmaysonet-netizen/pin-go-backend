import assert from "node:assert/strict";
import test from "node:test";

import {
  orchestrateOtaProvisioning,
  type OtaProvisioningRepository,
  type ProvisioningSnapshot,
} from "./ota-connection-orchestrator.service.js";

function setup(overrides: Partial<ProvisioningSnapshot> = {}) {
  const calls: string[] = [];
  const snapshot: ProvisioningSnapshot = {
    organizationId: "org-1",
    organizationName: "Organization One",
    propertyId: "property-1",
    propertyName: "Casa Uno",
    currency: "USD",
    timezone: "America/Puerto_Rico",
    groupId: "group-1",
    distributionPropertyId: "distribution-property-1",
    groupStatus: "NOT_PROVISIONED",
    propertyStatus: "NOT_PROVISIONED",
    groupLastErrorCode: null,
    propertyLastErrorCode: null,
    externalGroupId: null,
    externalPropertyId: null,
    externalPrimaryRoomTypeId: null,
    externalPrimaryRatePlanId: null,
    ...overrides,
  };
  const repository: OtaProvisioningRepository = {
    async loadTenantSnapshot() { calls.push("load"); return snapshot; },
    async claimGroup() { calls.push("claim-group"); return true; },
    async completeGroup() { calls.push("complete-group"); },
    async failGroup() { calls.push("fail-group"); },
    async claimProperty() { calls.push("claim-property"); return true; },
    async checkpointProperty() { calls.push("checkpoint-property"); },
    async checkpointPrimaryRoomType() { calls.push("checkpoint-room"); },
    async completeProperty() { calls.push("complete-property"); },
    async failProperty() { calls.push("fail-property"); },
  };
  const provisioner = {
    async ensureGroup() { calls.push("ensure-group"); return { externalGroupId: "group-ext" }; },
    async ensureProperty() {
      calls.push("ensure-property");
      return { externalPropertyId: "property-ext" };
    },
    async ensurePrimaryRoomType() { calls.push("ensure-room"); return { externalPrimaryRoomTypeId: "room-ext" }; },
    async ensurePrimaryRatePlan() { calls.push("ensure-rate"); return { externalPrimaryRatePlanId: "rate-ext" }; },
  };
  return { calls, repository, provisioner };
}

test("orchestrator prepares logical state before ordered provisioning", async () => {
  const { calls, repository, provisioner } = setup();
  const result = await orchestrateOtaProvisioning({
    repository,
    provisioner,
    async prepareLogicalConnection() { calls.push("prepare"); },
    organizationId: "org-1",
    propertyId: "property-1",
    requestedByUserId: "user-1",
    provider: "AIRBNB",
    requestKey: "request-123",
  });
  assert.deepEqual(result, { provisioningStatus: "READY" });
  assert.deepEqual(calls, [
    "prepare",
    "load",
    "claim-group",
    "ensure-group",
    "complete-group",
    "claim-property",
    "ensure-property",
    "checkpoint-property",
    "ensure-room",
    "checkpoint-room",
    "ensure-rate",
    "complete-property",
  ]);
});

test("a retry reuses persisted partial provisioning checkpoints", async () => {
  const { calls, repository, provisioner } = setup({
    groupStatus: "READY",
    propertyStatus: "FAILED",
    externalGroupId: "group-ext",
    externalPropertyId: "property-ext",
    externalPrimaryRoomTypeId: "room-ext",
  });
  await orchestrateOtaProvisioning({
    repository,
    provisioner,
    async prepareLogicalConnection() { calls.push("prepare"); },
    organizationId: "org-1",
    propertyId: "property-1",
    requestedByUserId: "user-1",
    provider: "AIRBNB",
    requestKey: "retry-request-123",
  });
  assert.equal(calls.includes("ensure-group"), false);
  assert.deepEqual(calls, [
    "prepare",
    "load",
    "claim-property",
    "ensure-property",
    "checkpoint-property",
    "ensure-room",
    "checkpoint-room",
    "ensure-rate",
    "complete-property",
  ]);
});

test("tenant mismatch stops before provider calls", async () => {
  const { calls, repository, provisioner } = setup({ organizationId: "org-other" });
  await assert.rejects(
    orchestrateOtaProvisioning({
      repository,
      provisioner,
      async prepareLogicalConnection() { calls.push("prepare"); },
      organizationId: "org-1",
      propertyId: "property-1",
      requestedByUserId: "user-1",
      provider: "BOOKING_COM",
      requestKey: "request-123",
    }),
    /OTA_DISTRIBUTION_TENANT_MISMATCH/
  );
  assert.deepEqual(calls, ["prepare", "load"]);
});

test("ambiguous provider errors require reconciliation and are not automatically retried", async () => {
  const { calls, repository, provisioner } = setup();
  provisioner.ensureGroup = async () => {
    calls.push("ensure-group");
    throw new Error("response contained secret-api-key");
  };
  await assert.rejects(
    orchestrateOtaProvisioning({
      repository,
      provisioner,
      async prepareLogicalConnection() { calls.push("prepare"); },
      organizationId: "org-1",
      propertyId: "property-1",
      requestedByUserId: "user-1",
      provider: "AIRBNB",
      requestKey: "request-123",
    }),
    /OTA_PROVIDER_RECONCILIATION_REQUIRED/
  );
  assert.equal(calls.includes("fail-group"), true);
  assert.equal(JSON.stringify(calls).includes("secret-api-key"), false);

  const retry = setup({
    groupStatus: "FAILED",
    groupLastErrorCode: "OTA_PROVIDER_RECONCILIATION_REQUIRED",
  });
  await assert.rejects(
    orchestrateOtaProvisioning({
      repository: retry.repository,
      provisioner: retry.provisioner,
      async prepareLogicalConnection() { retry.calls.push("prepare"); },
      organizationId: "org-1",
      propertyId: "property-1",
      requestedByUserId: "user-1",
      provider: "AIRBNB",
      requestKey: "retry-request-123",
    }),
    /OTA_PROVIDER_RECONCILIATION_REQUIRED/
  );
  assert.deepEqual(retry.calls, ["prepare", "load"]);
});
