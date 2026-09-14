import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import axios from "axios";
import { prisma } from "../lib/prisma";
import { configureChannexBookingWebhookForConnectionCenter } from "../services/channex-booking-webhook-registration.service";

import { buildOtaConnectionCenterComposition } from "./ota-connection-center.composition.js";
import type { OtaProvisioningRepository } from "./ota-connection-orchestrator.service.js";

type WebhookConfigurer = NonNullable<Parameters<typeof buildOtaConnectionCenterComposition>[0]["configureBookingWebhook"]>;
type LifecycleWebhookConfigurer = NonNullable<Parameters<typeof buildOtaConnectionCenterComposition>[0]["configureChannelLifecycleWebhook"]>;

function configuredComposition(
  configureBookingWebhook?: WebhookConfigurer,
  configureChannelLifecycleWebhook?: LifecycleWebhookConfigurer
) {
  const calls: string[] = [];
  const repository: OtaProvisioningRepository = {
    async alignPmsListingToReadyDistributionMapping() {
      calls.push("align-pms-mapping");
      return "ALIGNED";
    },
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
        groupStatus: "READY",
        propertyStatus: "READY",
        groupLastErrorCode: null,
        propertyLastErrorCode: null,
        externalGroupId: "group-ext",
        externalPropertyId: "certified-property",
        externalPrimaryRoomTypeId: "certified-room",
        externalPrimaryRatePlanId: "certified-rate",
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
    configureBookingWebhook: configureBookingWebhook ?? (async (input) => {
      assert.deepEqual(input, { organizationId: "org-1", propertyId: "property-1" });
      calls.push("register-booking-webhook");
      return { verified: true };
    }),
    configureChannelLifecycleWebhook: configureChannelLifecycleWebhook ?? (async (input) => {
      assert.deepEqual(input, { organizationId: "org-1", propertyId: "property-1" });
      calls.push("register-channel-lifecycle-webhook");
      return { verified: true };
    }),
    prepareLogicalConnection: async () => { calls.push("logical-prepare"); return {} as any; },
  });
  return { actions, calls, repository, adapter };
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

test("configured composition aligns PMS to READY distribution without provider provisioning", async () => {
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
    "align-pms-mapping",
    "register-booking-webhook",
    "register-channel-lifecycle-webhook",
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


const prepareInput = {
  organizationId: "org-1", propertyId: "property-1", requestedByUserId: "user-1",
  provider: "AIRBNB" as const, requestKey: "request-123",
};

test("new property registers only after inventory and canonical PMS linkage are persisted", async () => {
  const { actions, calls, repository } = configuredComposition();
  const snapshot = (await repository.loadTenantSnapshot("org-1", "property-1"))!;
  snapshot.groupStatus = "NOT_PROVISIONED";
  snapshot.propertyStatus = "NOT_PROVISIONED";
  snapshot.externalGroupId = null;
  snapshot.externalPropertyId = null;
  snapshot.externalPrimaryRoomTypeId = null;
  snapshot.externalPrimaryRatePlanId = null;
  repository.loadTenantSnapshot = async () => { calls.push("load"); return snapshot; };
  calls.length = 0;
  assert.deepEqual(await actions.prepare!(prepareInput), { provisioningStatus: "READY" });
  assert.deepEqual(calls, [
    "logical-prepare", "load", "claim-group", "transport-group", "complete-group",
    "claim-property", "transport-property", "checkpoint-property", "transport-room",
    "checkpoint-room", "transport-rate", "complete-property", "align-pms-mapping",
    "register-booking-webhook",
    "register-channel-lifecycle-webhook",
  ]);
});

test("preparation waits for webhook verification instead of returning READY early", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { actions } = configuredComposition(async () => {
    entered();
    await gate;
    return { verified: true };
  });
  let returned = false;
  const pending = actions.prepare!(prepareInput).then((value) => { returned = true; return value; });
  await started;
  assert.equal(returned, false);
  release();
  assert.deepEqual(await pending, { provisioningStatus: "READY" });
});

test("failed webhook verification returns a sanitized error and the READY mapping is retryable", async () => {
  let attempts = 0;
  const { actions, calls } = configuredComposition(async () => {
    attempts++;
    if (attempts === 1) throw new Error("request headers contained secret-api-key");
    return { verified: true };
  });
  await assert.rejects(actions.prepare!(prepareInput), (error: any) => {
    assert.equal(error.code, "OTA_BOOKING_WEBHOOK_REGISTRATION_FAILED");
    assert.equal(error.message, "OTA_BOOKING_WEBHOOK_REGISTRATION_FAILED");
    assert.equal(JSON.stringify(error).includes("secret-api-key"), false);
    return true;
  });
  assert.deepEqual(await actions.prepare!({ ...prepareInput, requestKey: "request-retry" }), { provisioningStatus: "READY" });
  assert.equal(attempts, 2);
  assert.deepEqual(calls, [
    "logical-prepare", "load", "align-pms-mapping",
    "logical-prepare", "load", "align-pms-mapping",
    "register-channel-lifecycle-webhook",
  ]);
});

test("lifecycle webhook verification is required after booking verification", async () => {
  const { actions } = configuredComposition(undefined, async () => ({ verified: false }));
  await assert.rejects(
    actions.prepare!(prepareInput),
    /OTA_CHANNEL_LIFECYCLE_WEBHOOK_REGISTRATION_FAILED/
  );
});

test("lifecycle webhook errors are sanitized", async () => {
  const { actions } = configuredComposition(undefined, async () => {
    throw new Error("request contained lifecycle-secret and canonical-api-key");
  });
  await assert.rejects(actions.prepare!(prepareInput), (error: any) => {
    assert.equal(error.code, "OTA_CHANNEL_LIFECYCLE_WEBHOOK_REGISTRATION_FAILED");
    assert.equal(JSON.stringify(error).includes("lifecycle-secret"), false);
    return true;
  });
});

test("unverified registrar output cannot produce a successful preparation", async () => {
  const { actions } = configuredComposition(async () => ({ verified: false }));
  await assert.rejects(actions.prepare!(prepareInput), /OTA_BOOKING_WEBHOOK_REGISTRATION_FAILED/);
});

test("failed PMS linkage cannot register a webhook", async () => {
  let registrations = 0;
  const { actions, repository } = configuredComposition(async () => {
    registrations++;
    return { verified: true };
  });
  repository.alignPmsListingToReadyDistributionMapping = async () => {
    throw new Error("OTA_PMS_MAPPING_ALIGNMENT_CONFLICT");
  };
  await assert.rejects(actions.prepare!(prepareInput), /OTA_PMS_MAPPING_ALIGNMENT_CONFLICT/);
  assert.equal(registrations, 0);
});

test("tenant mismatch cannot invoke the registrar", async () => {
  let registrations = 0;
  const { actions, repository } = configuredComposition(async () => {
    registrations++;
    return { verified: true };
  });
  const snapshot = (await repository.loadTenantSnapshot("org-1", "property-1"))!;
  snapshot.organizationId = "org-other";
  repository.loadTenantSnapshot = async () => snapshot;
  await assert.rejects(actions.prepare!(prepareInput), /OTA_DISTRIBUTION_TENANT_MISMATCH/);
  assert.equal(registrations, 0);
});

test("default-off composition never exposes a preparation action or invokes the registrar", () => {
  let registrations = 0;
  const actions = buildOtaConnectionCenterComposition({
    prisma: {} as any,
    trustedMutationOrigins: [],
    configureBookingWebhook: async () => { registrations++; return { verified: true }; },
  });
  assert.equal(actions.runtime.enabled, false);
  assert.equal(actions.prepare, undefined);
  assert.equal(registrations, 0);
});

test("the canonical composition defaults to the shared Connection Center registrar", () => {
  const source = readFileSync(new URL("./ota-connection-center.composition.ts", import.meta.url), "utf8");
  assert.match(source, /args\.configureBookingWebhook\s*\?\?\s*configureChannexBookingWebhookForConnectionCenter/);
  assert.doesNotMatch(source, /configure-channex-live-booking-webhook/);
});

test("composition and actual registrar complete the booking webhook flow using only mocked I/O", async () => {
  const prismaAny = prisma as any;
  const axiosAny = axios as any;
  const originals = {
    findMany: prismaAny.pmsListing.findMany, update: prismaAny.pmsListing.update,
    updateConnection: prismaAny.pmsConnection.update,
    post: axiosAny.post, put: axiosAny.put, get: axiosAny.get,
  };
  const steps: string[] = [];
  prismaAny.pmsListing.findMany = async (args: any) => {
    assert.equal(args.where.connection.is.organizationId, "org-1");
    assert.equal(args.where.propertyId, "property-1");
    steps.push("read-canonical-listing");
    return [{
      id: "listing-1", propertyId: "property-1", metadata: { channexPropertyId: "external-1" },
      connection: { id: "connection-1", organizationId: "org-1", webhookSecret: "test-secret" },
    }];
  };
  prismaAny.pmsListing.update = async (args: any) => {
    steps.push(args.data.metadata.channexBookingWebhookVerified ? "persist-verified" : "persist-pending");
    return args;
  };
  prismaAny.pmsConnection.update = async () => { throw new Error("existing secret must be reused"); };
  axiosAny.put = async () => { throw new Error("new property must not PUT"); };
  axiosAny.post = async (url: string, payload: any, options: any) => {
    steps.push("POST");
    assert.equal(url, "https://app.channex.io/api/v1/webhooks");
    assert.equal(options.headers["user-api-key"], "ota-integration-test-key");
    assert.equal(payload.webhook.property_id, "external-1");
    assert.equal(payload.webhook.event_mask, "booking");
    assert.equal(payload.webhook.send_data, false);
    assert.equal(payload.webhook.callback_url, "https://api.pin-ngo.com/webhooks/channex");
    return { data: { data: { id: "webhook-1" } } };
  };
  axiosAny.get = async (url: string) => {
    steps.push("GET");
    assert.equal(url, "https://app.channex.io/api/v1/webhooks/webhook-1");
    return { data: { data: {
      id: "webhook-1",
      attributes: {
        property_id: "external-1", callback_url: "https://api.pin-ngo.com/webhooks/channex",
        event_mask: "booking", send_data: false, is_active: true,
      },
    } } };
  };
  try {
    const { actions, repository } = configuredComposition((input) =>
      configureChannexBookingWebhookForConnectionCenter({
        ...input,
        env: Object.freeze({ NODE_ENV: "production", OTA_CONNECTION_API_KEY: "ota-integration-test-key", OTA_CONNECTION_PROVIDER_API_ORIGIN: "https://app.channex.io" }),
      })
    );
    repository.alignPmsListingToReadyDistributionMapping = async () => {
      steps.push("align-committed"); return "CREATED";
    };
    assert.deepEqual(await actions.prepare!({ ...prepareInput, provider: "BOOKING_COM" }), { provisioningStatus: "READY" });
    assert.deepEqual(steps, ["align-committed", "read-canonical-listing", "POST", "persist-pending", "GET", "persist-verified"]);
  } finally {
    prismaAny.pmsListing.findMany = originals.findMany;
    prismaAny.pmsListing.update = originals.update;
    prismaAny.pmsConnection.update = originals.updateConnection;
    axiosAny.post = originals.post; axiosAny.put = originals.put; axiosAny.get = originals.get;
  }
});
