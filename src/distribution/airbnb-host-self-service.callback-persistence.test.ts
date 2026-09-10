import assert from "node:assert/strict";
import test from "node:test";

import {
  captureAirbnbCallbackPersistenceGuard,
  persistVerifiedAirbnbCallback,
  verifyAndPersistAirbnbHostCallback,
  type AirbnbCallbackPersistenceClient,
} from "./airbnb-host-self-service.callback-persistence.js";

const CHANNEL = "716305c4-561a-4561-a187-7f5b8aeb5920";
const OTHER_CHANNEL = "96177287-c3b2-4d98-9eb7-5c1927795825";
const PROPERTY_EXTERNAL = "1519fa73-a0f4-44f3-ab8d-d29412834588";
const OTHER_PROPERTY_EXTERNAL = "1519fa73-a0f4-44f3-ab8d-d29412834589";
const GROUP_EXTERNAL = "a60df2a7-fbaf-49b5-a8bb-35e736d5e24d";
const NOW = new Date("2026-09-09T23:54:49.000Z");

function baseConnection(externalConnectionId: string | null = null) {
  return {
    id: "ota-airbnb-1",
    organizationId: "org-1",
    propertyId: "property-1",
    distributionPropertyId: "distribution-property-1",
    provider: "AIRBNB",
    status: "NOT_CONNECTED",
    externalConnectionId,
    readinessRevision: 0,
    updatedAt: new Date("2026-09-09T23:47:20.000Z"),
    distributionProperty: {
      id: "distribution-property-1",
      organizationId: "org-1",
      propertyId: "property-1",
      groupId: "distribution-group-1",
      platform: "CHANNEX",
      provisioningStatus: "READY",
      externalPropertyId: PROPERTY_EXTERNAL,
      updatedAt: new Date("2026-09-09T23:47:19.000Z"),
      group: {
        id: "distribution-group-1",
        organizationId: "org-1",
        platform: "CHANNEX",
        provisioningStatus: "READY",
        externalGroupId: GROUP_EXTERNAL,
        updatedAt: new Date("2026-09-09T23:47:18.000Z"),
      },
    },
  };
}

function harness(args: {
  externalConnectionId?: string | null;
  updateCounts?: number[];
  existingAudit?: any;
} = {}) {
  const connection = baseConnection(args.externalConnectionId ?? null);
  const updateCounts = [...(args.updateCounts ?? [1])];
  let audit = args.existingAudit ?? null;
  const updates: any[] = [];
  const audits: any[] = [];
  let transactions = 0;
  const find = async (query: any) => {
    assert.deepEqual(query.where, {
      organizationId: "org-1",
      propertyId: "property-1",
      provider: "AIRBNB",
    });
    return connection;
  };
  const client: AirbnbCallbackPersistenceClient = {
    otaChannelConnection: { findFirst: find },
    async $transaction(work, options) {
      transactions += 1;
      assert.deepEqual(options, { isolationLevel: "Serializable" });
      return work({
        otaChannelConnection: {
          findFirst: find,
          async updateMany(query) {
            updates.push(query);
            const count = updateCounts.shift() ?? 1;
            if (count === 1) {
              connection.externalConnectionId = query.data.externalConnectionId;
              connection.updatedAt = new Date(connection.updatedAt.getTime() + 1_000);
            }
            return { count };
          },
        },
        apmsAuditEntry: {
          async findUnique() {
            return audit;
          },
          async create(query) {
            audits.push(query);
            audit = { id: "audit-1", ...query.data };
            return audit;
          },
        },
      });
    },
  };
  return { client, connection, updates, audits, get transactions() { return transactions; } };
}

async function guard(client: AirbnbCallbackPersistenceClient) {
  return captureAirbnbCallbackPersistenceGuard({
    client,
    organizationId: "org-1",
    propertyId: "property-1",
    channelId: CHANNEL,
  });
}

async function persist(client: AirbnbCallbackPersistenceClient) {
  const persistenceGuard = await guard(client);
  return persistVerifiedAirbnbCallback({
    client,
    guard: persistenceGuard,
    organizationId: "org-1",
    propertyId: "property-1",
    requestedByUserId: "user-1",
    channelId: CHANNEL,
    now: NOW,
  });
}

test("verified callback persists only the external connection reference and audit evidence", async () => {
  const h = harness();
  await persist(h.client);

  assert.equal(h.connection.externalConnectionId, CHANNEL);
  assert.equal(h.connection.status, "NOT_CONNECTED");
  assert.equal(h.connection.readinessRevision, 0);
  assert.equal(h.updates.length, 1);
  assert.deepEqual(h.updates[0].data, { externalConnectionId: CHANNEL });
  assert.equal(h.audits.length, 1);
  const audit = h.audits[0].data;
  assert.equal(audit.engine, "OTA_AIRBNB_CALLBACK");
  assert.equal(audit.eventType, "CALLBACK_RESOURCE_VERIFIED");
  assert.equal(audit.reason, "CALLBACK_RESOURCE_ONLY");
  assert.equal(audit.metadata.channelId, CHANNEL);
  assert.equal(audit.metadata.lifecycleStatusChanged, false);
  assert.equal(audit.metadata.activationChanged, false);
});

test("existing different channel reference fails before provider-side verification or writes", async () => {
  const h = harness({ externalConnectionId: OTHER_CHANNEL });
  await assert.rejects(
    guard(h.client),
    (error: any) => error?.code === "OTA_AIRBNB_CALLBACK_CHANNEL_CONFLICT"
  );
  assert.equal(h.transactions, 0);
  assert.equal(h.updates.length, 0);
  assert.equal(h.audits.length, 0);
});

test("scope drift after pre-verification guard fails closed without persistence", async () => {
  const h = harness();
  const persistenceGuard = await guard(h.client);
  h.connection.distributionProperty.externalPropertyId = OTHER_PROPERTY_EXTERNAL;
  h.connection.distributionProperty.updatedAt = new Date("2026-09-09T23:55:00.000Z");
  await assert.rejects(
    persistVerifiedAirbnbCallback({
      client: h.client,
      guard: persistenceGuard,
      organizationId: "org-1",
      propertyId: "property-1",
      requestedByUserId: "user-1",
      channelId: CHANNEL,
      now: NOW,
    }),
    (error: any) => error?.code === "OTA_AIRBNB_CALLBACK_STATE_CHANGED"
  );
  assert.equal(h.updates.length, 0);
  assert.equal(h.audits.length, 0);
});

test("same callback can replay idempotently after persistence", async () => {
  const h = harness({ externalConnectionId: CHANNEL });
  await persist(h.client);
  assert.equal(h.audits.length, 1);
  await persist(h.client);
  assert.equal(h.updates.length, 0);
  assert.equal(h.audits.length, 1);
});

test("tampered idempotency audit is rejected instead of trusted", async () => {
  const initial = harness({ externalConnectionId: CHANNEL });
  await persist(initial.client);
  const tampered = {
    ...initial.audits[0].data,
    metadata: { ...initial.audits[0].data.metadata, channelId: OTHER_CHANNEL },
  };
  const h = harness({ externalConnectionId: CHANNEL, existingAudit: tampered });
  await assert.rejects(
    persist(h.client),
    (error: any) => error?.code === "OTA_AIRBNB_CALLBACK_PERSISTENCE_CONFLICT"
  );
  assert.equal(h.updates.length, 0);
  assert.equal(h.audits.length, 0);
});

test("local CAS conflict may retry without repeating provider verification", async () => {
  const h = harness({ updateCounts: [0, 1] });
  const persistenceGuard = await guard(h.client);
  let verificationCalls = 0;
  const result = await verifyAndPersistAirbnbHostCallback({
    verify: async () => {
      verificationCalls += 1;
      return {
        success: true,
        propertyId: "property-1",
        channelId: CHANNEL,
        channelActive: false,
        airbnbAccountVerified: false as const,
        nextAction: "LISTING_DISCOVERY_REQUIRED" as const,
      };
    },
    client: h.client,
    guard: persistenceGuard,
    organizationId: "org-1",
    requestedByUserId: "user-1",
    now: NOW,
  });
  assert.equal(verificationCalls, 1);
  assert.equal(h.transactions, 2);
  assert.equal(h.updates.length, 2);
  assert.equal(result.channelId, CHANNEL);
  assert.equal(h.connection.externalConnectionId, CHANNEL);
});

test("failed authorization result performs no persistence", async () => {
  const h = harness();
  const persistenceGuard = await guard(h.client);
  const result = await verifyAndPersistAirbnbHostCallback({
    verify: async () => ({
      success: false,
      propertyId: null,
      channelId: null,
      channelActive: null,
      airbnbAccountVerified: false as const,
      nextAction: "RETRY_AUTHORIZATION" as const,
    }),
    client: h.client,
    guard: persistenceGuard,
    organizationId: "org-1",
    requestedByUserId: "user-1",
    now: NOW,
  });
  assert.equal(result.success, false);
  assert.equal(h.transactions, 0);
  assert.equal(h.updates.length, 0);
  assert.equal(h.audits.length, 0);
});
