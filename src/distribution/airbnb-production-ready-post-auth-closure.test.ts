import assert from "node:assert/strict";
import test from "node:test";

import {
  AIRBNB_LIFECYCLE_WEBHOOK_EVENT_MASK,
  ensureAirbnbGlobalLifecycleWebhook,
  normalizeChannexLifecycleWebhookPayload,
} from "./airbnb-lifecycle-webhook.production.js";
import { recoverMissedAirbnbActivation } from "./airbnb-missed-activation.recovery.js";

const PROPERTY_ID = "b58de550-63f8-49dc-abfa-4629b94a2160";
const GROUP_ID = "a05d501f-7d1a-40fd-a21e-2805d818e527";
const CHANNEL_ID = "04ef2057-cca7-4e28-be54-f991f461a1cd";
const RATE_PLAN_ID = "bfd7dfe7-0c6d-4145-bbc4-45546780d720";
const LISTING_ID = "551126434553599406";
const CALLBACK = "https://api.pin-ngo.com/webhooks/ota/channex/channel-lifecycle";
const SECRET = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const WEBHOOK_ID = "11111111-1111-4111-8111-111111111111";

function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function globalWebhookResource(overrides: Record<string, unknown> = {}) {
  return {
    id: WEBHOOK_ID,
    type: "webhook",
    attributes: {
      property_id: null,
      is_global: true,
      callback_url: CALLBACK,
      event_mask: AIRBNB_LIFECYCLE_WEBHOOK_EVENT_MASK,
      headers: { "x-pin-go-ota-channel-webhook-secret": SECRET },
      is_active: true,
      send_data: true,
      ...overrides,
    },
    relationships: { property: { data: null } },
  };
}

test("official disconnect_channel remains canonical and historic spelling is normalized", () => {
  const canonical = {
    event: "disconnect_channel",
    property_id: PROPERTY_ID,
    timestamp: "2026-09-10T17:20:00Z",
    payload: { channel_id: CHANNEL_ID, ota_name: "Airbnb" },
  };
  assert.deepEqual(normalizeChannexLifecycleWebhookPayload(canonical), canonical);
  assert.deepEqual(
    normalizeChannexLifecycleWebhookPayload({ ...canonical, event: "disconnected_channel" }),
    canonical
  );
});

test("global lifecycle webhook create is exact, persisted and one provider mutation", async () => {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  let created = false;
  const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? "GET");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url, body });
    if (method === "GET" && url.endsWith("/api/v1/webhooks")) {
      return response(200, { data: [] });
    }
    if (method === "POST") {
      created = true;
      return response(201, { data: globalWebhookResource() });
    }
    if (method === "GET" && url.endsWith(`/webhooks/${WEBHOOK_ID}`)) {
      assert.equal(created, true);
      return response(200, { data: globalWebhookResource() });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };

  const result = await ensureAirbnbGlobalLifecycleWebhook({
    apiOrigin: "https://app.channex.io",
    apiKey: "key",
    callbackUrl: CALLBACK,
    webhookSecret: SECRET,
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.deepEqual(result, {
    status: "CREATED",
    webhookId: WEBHOOK_ID,
    providerMutations: 1,
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.url.endsWith("/api/v1/webhooks"), true);
  assert.equal(calls[0]!.url.includes("pagination"), false);
  assert.equal(calls[1]!.body.webhook.property_id, null);
  assert.equal(calls[1]!.body.webhook.is_global, true);
  assert.equal(calls[1]!.body.webhook.callback_url, CALLBACK);
  assert.equal(calls[1]!.body.webhook.event_mask, AIRBNB_LIFECYCLE_WEBHOOK_EVENT_MASK);
  assert.equal(calls[1]!.body.webhook.event_mask.includes("disconnect_channel"), true);
  assert.equal(calls[1]!.body.webhook.event_mask.includes("disconnected_channel"), false);
  assert.equal(calls[1]!.body.webhook.event_mask.includes("booking"), false);
  assert.equal(calls[1]!.body.webhook.is_active, true);
  assert.equal(calls[1]!.body.webhook.send_data, true);
});

test("exact existing global webhook performs no provider mutation", async () => {
  let writes = 0;
  const fetchImpl = async (_input: URL | RequestInfo, init?: RequestInit) => {
    if (String(init?.method ?? "GET") !== "GET") writes += 1;
    return response(200, { data: [globalWebhookResource()] });
  };
  const result = await ensureAirbnbGlobalLifecycleWebhook({
    apiOrigin: "https://app.channex.io",
    apiKey: "key",
    callbackUrl: CALLBACK,
    webhookSecret: SECRET,
    fetchImpl: fetchImpl as typeof fetch,
  });
  assert.equal(result.status, "UNCHANGED");
  assert.equal(result.providerMutations, 0);
  assert.equal(writes, 0);
});

test("mixed-scope global webhook fails closed instead of overwriting unrelated events", async () => {
  let writes = 0;
  const fetchImpl = async (_input: URL | RequestInfo, init?: RequestInit) => {
    if (String(init?.method ?? "GET") !== "GET") writes += 1;
    return response(200, {
      data: [globalWebhookResource({ event_mask: "activate_channel;booking" })],
    });
  };
  await assert.rejects(
    () => ensureAirbnbGlobalLifecycleWebhook({
      apiOrigin: "https://app.channex.io",
      apiKey: "key",
      callbackUrl: CALLBACK,
      webhookSecret: SECRET,
      fetchImpl: fetchImpl as typeof fetch,
    }),
    /AIRBNB_LIFECYCLE_WEBHOOK_SCOPE_CONFLICT/
  );
  assert.equal(writes, 0);
});

test("missed activation recovery records provider observation, not synthetic webhook", async () => {
  const auditRows: any[] = [];
  let updateData: any = null;
  const connection = {
    id: "cmttiomxe0005p51553hxn62i",
    organizationId: "cmo1syqey0001p01dlopyf5w5",
    propertyId: "cmo1t0gwq000bp01d0wrujlh2",
    provider: "AIRBNB",
    status: "NOT_CONNECTED",
    externalConnectionId: CHANNEL_ID,
    externalChannelCode: null,
    externalListingId: null,
    readinessRevision: 0,
    updatedAt: new Date("2026-09-10T17:00:00Z"),
    lastLifecycleOccurredAt: null,
    lastLifecycleOccurredAtMicros: null,
    lastLifecycleEventType: null,
    lastLifecycleEventPrecedence: null,
    channelAuthorizationVerifiedAt: null,
    lastChannelActivatedAt: null,
    distributionProperty: {
      platform: "CHANNEX",
      provisioningStatus: "READY",
      externalPropertyId: PROPERTY_ID,
      externalPrimaryRatePlanId: RATE_PLAN_ID,
      group: {
        platform: "CHANNEX",
        provisioningStatus: "READY",
        externalGroupId: GROUP_ID,
      },
    },
  };
  const tx = {
    otaChannelConnection: {
      async findFirst() { return connection; },
      async updateMany(args: any) { updateData = args.data; return { count: 1 }; },
    },
    apmsAuditEntry: {
      async create(args: any) { auditRows.push(args.data); return args.data; },
    },
  };
  const prisma: any = {
    apmsAuditEntry: { async findUnique() { return null; } },
    async $transaction(work: any) { return work(tx); },
  };
  const provider: any = {
    async getChannel() {
      return {
        id: CHANNEL_ID,
        isActive: true,
        groupId: GROUP_ID,
        propertyIds: [PROPERTY_ID],
        mappings: [{
          id: "22222222-2222-4222-8222-222222222222",
          ratePlanId: RATE_PLAN_ID,
          listingId: LISTING_ID,
        }],
      };
    },
  };
  const observedAt = new Date("2026-09-10T17:30:00Z");
  const result = await recoverMissedAirbnbActivation({
    prisma,
    provider,
    observedAt,
    target: {
      organizationId: connection.organizationId,
      propertyId: connection.propertyId,
      connectionId: connection.id,
      channelId: CHANNEL_ID,
      externalPropertyId: PROPERTY_ID,
      externalGroupId: GROUP_ID,
      ratePlanId: RATE_PLAN_ID,
      listingId: LISTING_ID,
    },
  });
  assert.equal(result.recovered, true);
  assert.equal(updateData.lastLifecycleEventType, "activate_channel");
  assert.equal(updateData.lastLifecycleEventPrecedence, 30);
  assert.equal(updateData.externalChannelCode, "ABB");
  assert.equal(updateData.externalListingId, LISTING_ID);
  assert.equal(updateData.authorizationReadiness, "IN_PROGRESS");
  assert.equal(updateData.mappingReadiness, "IN_PROGRESS");
  assert.equal(updateData.distributionReadiness, "IN_PROGRESS");
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].engine, "OTA_DISTRIBUTION_RECOVERY");
  assert.equal(auditRows[0].eventType, "MISSED_ACTIVATION_RECOVERED");
  assert.equal(auditRows[0].metadata.syntheticWebhook, false);
  assert.equal(
    auditRows[0].metadata.evidenceSource,
    "CHANNEX_PROVIDER_READ_AFTER_CONFIRMED_ACTIVATION"
  );
});

test("missed activation recovery fails closed when provider mapping changes", async () => {
  const prisma: any = {
    apmsAuditEntry: { async findUnique() { return null; } },
    async $transaction() { throw new Error("must not write"); },
  };
  const provider: any = {
    async getChannel() {
      return {
        id: CHANNEL_ID,
        isActive: true,
        groupId: GROUP_ID,
        propertyIds: [PROPERTY_ID],
        mappings: [],
      };
    },
  };
  await assert.rejects(
    () => recoverMissedAirbnbActivation({
      prisma,
      provider,
      target: {
        organizationId: "cmo1syqey0001p01dlopyf5w5",
        propertyId: "cmo1t0gwq000bp01d0wrujlh2",
        connectionId: "cmttiomxe0005p51553hxn62i",
        channelId: CHANNEL_ID,
        externalPropertyId: PROPERTY_ID,
        externalGroupId: GROUP_ID,
        ratePlanId: RATE_PLAN_ID,
        listingId: LISTING_ID,
      },
    }),
    /AIRBNB_MISSED_ACTIVATION_PROVIDER_EVIDENCE_INVALID/
  );
});
