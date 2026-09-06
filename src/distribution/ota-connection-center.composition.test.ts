import assert from "node:assert/strict";
import test from "node:test";

import { buildOtaConnectionCenterComposition } from "./ota-connection-center.composition.js";
import type { OtaProvisioningRepository } from "./ota-connection-orchestrator.service.js";

function configuredComposition() {
  const calls: string[] = [];
  const repository: OtaProvisioningRepository = {
    async loadTenantSnapshot() {
      calls.push("load");
      return {
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
      };
    },
    async claimGroup() { calls.push("claim-group"); return true; },
    async completeGroup() { calls.push("complete-group"); },
    async failGroup() { calls.push("fail-group"); },
    async claimProperty() { calls.push("claim-property"); return true; },
    async checkpointProperty() { calls.push("checkpoint-property"); },
    async checkpointPrimaryRoomType() { calls.push("checkpoint-room"); },
    async completeProperty() { calls.push("complete-property"); },
    async failProperty() { calls.push("fail-property"); },
  };
  const adapter = {
    async ensureGroup() { calls.push("transport-group"); return { externalGroupId: "group-ext" }; },
    async ensureProperty() { calls.push("transport-property"); return { externalPropertyId: "property-ext" }; },
    async ensurePrimaryRoomType() { calls.push("transport-room"); return { externalPrimaryRoomTypeId: "room-ext" }; },
    async ensurePrimaryRatePlan() { calls.push("transport-rate"); return { externalPrimaryRatePlanId: "rate-ext" }; },
    async issue() { calls.push("transport-token"); return { token: "token", launchUrl: "https://staging.channex.io/channels" }; },
  };
  const actions = buildOtaConnectionCenterComposition({
    prisma: {} as any,
    runtimeValue: "true",
    trustedMutationOrigins: ["https://app.pin-ngo.com"],
    allowedLaunchOrigins: ["https://staging.channex.io"],
    defaultCurrency: "USD",
    adapter,
    repository,
    prepareLogicalConnection: async () => { calls.push("logical-prepare"); return {} as any; },
  });
  return { actions, calls };
}

test("runtime stays off when absent, malformed, or missing an adapter", () => {
  const base = { prisma: {} as any, trustedMutationOrigins: [] };
  assert.deepEqual(buildOtaConnectionCenterComposition(base).runtime, {
    enabled: false,
    reason: "DEFAULT_OFF",
  });
  assert.deepEqual(buildOtaConnectionCenterComposition({ ...base, runtimeValue: "yes" }).runtime, {
    enabled: false,
    reason: "INVALID_CONFIGURATION",
  });
  assert.deepEqual(buildOtaConnectionCenterComposition({ ...base, runtimeValue: "true" }).runtime, {
    enabled: false,
    reason: "ADAPTER_UNAVAILABLE",
  });
});

test("adapter alone cannot activate incomplete currency or launch-origin configuration", () => {
  const { actions } = configuredComposition();
  const incomplete = buildOtaConnectionCenterComposition({
    prisma: {} as any,
    runtimeValue: "true",
    trustedMutationOrigins: [],
    adapter: {
      ensureGroup: async () => ({ externalGroupId: "group" }),
      ensureProperty: async () => ({ externalPropertyId: "property" }),
      ensurePrimaryRoomType: async () => ({ externalPrimaryRoomTypeId: "room" }),
      ensurePrimaryRatePlan: async () => ({ externalPrimaryRatePlanId: "rate" }),
      issue: async () => ({ token: "token", launchUrl: "https://example.test" }),
    },
  });
  assert.equal(actions.runtime.enabled, true);
  assert.deepEqual(incomplete.runtime, { enabled: false, reason: "CONFIGURATION_INCOMPLETE" });

  const insecureLaunch = buildOtaConnectionCenterComposition({
    prisma: {} as any,
    runtimeValue: "true",
    trustedMutationOrigins: [],
    allowedLaunchOrigins: ["http://staging.example.test"],
    defaultCurrency: "USD",
    adapter: {} as any,
  });
  assert.deepEqual(insecureLaunch.runtime, {
    enabled: false,
    reason: "CONFIGURATION_INCOMPLETE",
  });
});

test("configured composition executes the full fake provisioning boundary", async () => {
  const { actions, calls } = configuredComposition();
  assert.ok(actions.prepare);
  const result = await actions.prepare!({
    organizationId: "org-1",
    propertyId: "property-1",
    requestedByUserId: "user-1",
    provider: "AIRBNB",
    requestKey: "request-123",
  });
  assert.deepEqual(result, { provisioningStatus: "READY" });
  assert.deepEqual(calls, [
    "logical-prepare",
    "load",
    "claim-group",
    "transport-group",
    "complete-group",
    "claim-property",
    "transport-property",
    "checkpoint-property",
    "transport-room",
    "checkpoint-room",
    "transport-rate",
    "complete-property",
  ]);
});

test("trusted mutation origin remains tenant aware", async () => {
  const actions = buildOtaConnectionCenterComposition({
    prisma: {} as any,
    trustedMutationOrigins: ["https://app.pin-ngo.com/path"],
    isTenantOriginAllowed: async (origin, organizationId) =>
      origin === "https://brand.example" && organizationId === "org-1",
  });
  assert.equal(await actions.isTrustedOrigin("https://app.pin-ngo.com", "org-2"), true);
  assert.equal(await actions.isTrustedOrigin("https://brand.example", "org-1"), true);
  assert.equal(await actions.isTrustedOrigin("https://brand.example", "org-2"), false);
});
