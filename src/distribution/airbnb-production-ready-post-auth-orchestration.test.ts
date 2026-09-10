import assert from "node:assert/strict";
import test from "node:test";

import { processChannexChannelLifecycleWebhook } from "../routes/channex-channel-lifecycle.webhook.route.js";
import { runAirbnbPostActivationCycle } from "./airbnb-post-auth-production.orchestrator.js";

const ORG_ID = "cmo1syqey0001p01dlopyf5w5";
const PROPERTY_ID = "cmo1t0gwq000bp01d0wrujlh2";
const CONNECTION_ID = "cmttiomxe0005p51553hxn62i";
const EXTERNAL_PROPERTY_ID = "b58de550-63f8-49dc-abfa-4629b94a2160";
const GROUP_ID = "a05d501f-7d1a-40fd-a21e-2805d818e527";
const CHANNEL_ID = "04ef2057-cca7-4e28-be54-f991f461a1cd";
const RATE_PLAN_ID = "bfd7dfe7-0c6d-4145-bbc4-45546780d720";
const LISTING_ID = "551126434553599406";

test("lifecycle route normalizes official disconnected_channel before canonical evidence", async () => {
  let received: any = null;
  const result = await processChannexChannelLifecycleWebhook({
    enabled: true,
    expectedSecret: "secret-1",
    headers: { "x-pin-go-ota-channel-webhook-secret": "secret-1" },
    body: {
      event: "disconnected_channel",
      timestamp: "2026-09-10T18:00:00Z",
      property_id: EXTERNAL_PROPERTY_ID,
      payload: { channel_id: CHANNEL_ID, ota_name: "Airbnb" },
    },
    async applyEvidence(payload) {
      received = payload;
      return {
        ignored: false,
        deduped: false,
        connectionId: CONNECTION_ID,
        eventType: "disconnect_channel",
      };
    },
  });

  assert.equal(result.status, 200);
  assert.equal(received.event, "disconnect_channel");
  assert.equal(received.property_id, EXTERNAL_PROPERTY_ID);
  assert.equal(received.payload.channel_id, CHANNEL_ID);
});

test("post-activation cycle reuses completed full sync and reconciles to ACTIVE without requeue", async () => {
  const activatedAt = new Date("2026-09-10T18:00:00Z");
  const completedAt = new Date("2026-09-10T18:02:00Z");
  const connection = {
    id: CONNECTION_ID,
    organizationId: ORG_ID,
    propertyId: PROPERTY_ID,
    provider: "AIRBNB",
    status: "ACTIVATION_PENDING",
    externalConnectionId: CHANNEL_ID,
    readinessRevision: 2,
    lastChannelActivatedAt: activatedAt,
    distributionProperty: {
      platform: "CHANNEX",
      provisioningStatus: "READY",
      externalPropertyId: EXTERNAL_PROPERTY_ID,
      externalPrimaryRatePlanId: RATE_PLAN_ID,
      group: {
        platform: "CHANNEX",
        provisioningStatus: "READY",
        externalGroupId: GROUP_ID,
      },
      property: {
        id: PROPERTY_ID,
        organizationId: ORG_ID,
        status: "ACTIVE",
        timezone: "America/Puerto_Rico",
      },
    },
  };

  const outboxRows = [
    {
      id: "outbox-a",
      messageKind: "AVAILABILITY",
      syncMode: "FULL",
      scope: "FULL_HORIZON",
      trigger: "AIRBNB_POST_ACTIVATION_AUTOPILOT",
      sourceEntityType: "OTA_CHANNEL_CONNECTION",
      sourceEntityId: CONNECTION_ID,
      status: "MERGED",
      deliveryId: "delivery-a",
      createdAt: activatedAt,
      delivery: { status: "SENT" },
    },
    {
      id: "outbox-r",
      messageKind: "RATES_RESTRICTIONS",
      syncMode: "FULL",
      scope: "FULL_HORIZON",
      trigger: "AIRBNB_POST_ACTIVATION_AUTOPILOT",
      sourceEntityType: "OTA_CHANNEL_CONNECTION",
      sourceEntityId: CONNECTION_ID,
      status: "MERGED",
      deliveryId: "delivery-r",
      createdAt: activatedAt,
      delivery: { status: "SENT" },
    },
  ];

  let transactionCalls = 0;
  let reconciled = 0;
  let canonicalActive = false;
  const prisma: any = {
    otaChannelConnection: {
      async findMany() { return [connection]; },
      async findFirst() {
        return canonicalActive
          ? {
              status: "ACTIVE",
              authorizationReadiness: "READY",
              mappingReadiness: "READY",
              distributionReadiness: "READY",
            }
          : null;
      },
    },
    distributionOutboxEvent: {
      async findMany() { return outboxRows; },
    },
    channexAriPropertyState: {
      async findUnique() {
        return {
          organizationId: ORG_ID,
          lastFullSyncRequestedAt: activatedAt,
          lastFullSyncCompletedAt: completedAt,
        };
      },
    },
    async $transaction() {
      transactionCalls += 1;
      throw new Error("must not queue another full sync");
    },
  };

  const provider: any = {
    async getChannel() {
      return {
        id: CHANNEL_ID,
        propertyIds: [EXTERNAL_PROPERTY_ID],
        groupId: GROUP_ID,
        isActive: true,
        mappings: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            ratePlanId: RATE_PLAN_ID,
            listingId: LISTING_ID,
          },
        ],
      };
    },
  };

  const reconcile: any = async () => {
    reconciled += 1;
    canonicalActive = true;
    return {};
  };

  const result = await runAirbnbPostActivationCycle({
    prisma,
    provider,
    reconcile,
    connectionId: CONNECTION_ID,
    now: completedAt,
  });

  assert.equal(transactionCalls, 0);
  assert.equal(reconciled, 1);
  assert.equal(result.scanned, 1);
  assert.equal(result.queued, 0);
  assert.equal(result.reconciled, 1);
  assert.equal(result.active, 1);
  assert.equal(result.items[0]?.outcome, "ACTIVE");
  assert.equal(result.items[0]?.reason, "CANONICAL_ACTIVE");
});
