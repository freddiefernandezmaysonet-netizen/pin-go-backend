import assert from "node:assert/strict";
import test from "node:test";
import {
  activateAirbnbForHost,
  inspectAirbnbActivation,
  verifyAirbnbActivationForHost,
  AIRBNB_ACTIVATION_CONFIRMATION,
  AIRBNB_ACTIVATION_VERIFICATION_CONFIRMATION,
} from "./airbnb-host-activation.service.js";
import { AirbnbActivationError } from "./airbnb-host-activation.http-transport.js";
import { calculateChannexAriCanonicalJsonIntegrity } from "../pms/outbound/channex-ari-canonical-json.policy.js";

const property = "11111111-1111-4111-8111-111111111111";
const room = "22222222-2222-4222-8222-222222222222";
const rate = "33333333-3333-4333-8333-333333333333";
const channel = "44444444-4444-4444-8444-444444444444";
const group = "55555555-5555-4555-8555-555555555555";
const mapping = "66666666-6666-4666-8666-666666666666";
const now = new Date("2026-09-13T18:00:00Z");
const scope = { organizationId: "org-1", propertyId: "property-1" };

function fixture() {
  const dp = { ...scope, id: "dp-1", platform: "CHANNEX", provisioningStatus: "READY", updatedAt: now,
    externalPropertyId: property, externalPrimaryRoomTypeId: room, externalPrimaryRatePlanId: rate,
    property: { id: scope.propertyId, organizationId: scope.organizationId, distributionEnabled: true, distributionStatus: "ACTIVE", timezone: "America/Puerto_Rico" },
    group: { organizationId: scope.organizationId, platform: "CHANNEX", provisioningStatus: "READY", externalGroupId: group } };
  const connection = { ...scope, id: "ota-1", provider: "AIRBNB", distributionPropertyId: dp.id,
    externalConnectionId: channel, externalListingId: null, status: "AUTHORIZATION_REQUIRED", readinessRevision: 1, updatedAt: now, activationRequestedAt: null as Date | null };
  const listing = { id: "listing-1", connectionId: "pms-1", propertyId: scope.propertyId, externalListingId: room, updatedAt: now,
    metadata: { provider: "CHANNEX", channexPropertyId: property, channexRatePlanId: rate },
    connection: { id: "pms-1", organizationId: scope.organizationId, provider: "CHANNEX", status: "ACTIVE" } };
  const state = { ...scope, lastFullSyncRequestedAt: new Date("2026-09-13T15:36:00Z"), lastFullSyncCompletedAt: new Date("2026-09-13T15:37:00Z") };
  const events = ["AVAILABILITY", "RATES_RESTRICTIONS"].map(messageKind => {
    const payload = { values: [{ property_id: property, ...(messageKind === "AVAILABILITY" ? { room_type_id: room, availability: 1 } : { rate_plan_id: rate, rate: 150 }), date_from: "2026-09-13", date_to: "2028-01-25" }] };
    const shared = { ...scope, messageKind, syncMode: "FULL", scope: "FULL_HORIZON", dateFrom: new Date("2026-09-13"), dateToExclusive: new Date("2028-01-26") };
    return { ...shared, id: `event-${messageKind}`, provider: "CHANNEX", status: "MERGED", correlationId: "sync-1", deliveryId: `delivery-${messageKind}`,
      delivery: { ...shared, id: `delivery-${messageKind}`, connectionId: listing.connectionId, listingId: listing.id, status: "SENT", httpStatus: 200, warningCount: 0,
        sentAt: new Date("2026-09-13T15:36:45Z"), payload, payloadValueCount: 1, ...calculateChannexAriCanonicalJsonIntegrity(payload) } };
  });
  const remote = { data: { id: channel, type: "channel", attributes: { channel: "AirBNB", is_active: false,
    properties: [property], rate_plans: [{ id: mapping, rate_plan_id: rate, settings: { listing_id: "551126434553599406" } }] }, relationships: { group: { data: { id: group, type: "group" } } } } };
  const audits = new Map<string, any>();
  const queries: any[] = [], writes: any[] = [];
  let posts = 0, gets = 0, reconciles = 0;
  const client: any = {
    distributionProperty: { findFirst: async (q: any) => { queries.push(q); return structuredClone(dp); } },
    otaChannelConnection: {
      findFirst: async (q: any) => { queries.push(q); return structuredClone(connection); },
      updateMany: async (q: any) => {
        writes.push(q);
        if (q.where.activationRequestedAt === null && connection.activationRequestedAt !== null) return { count: 0 };
        Object.assign(connection, q.data, { updatedAt: new Date(connection.updatedAt.getTime() + 1) }); return { count: 1 };
      },
    },
    pmsListing: { findMany: async () => [structuredClone(listing)] },
    channexAriPropertyState: { findUnique: async () => structuredClone(state) },
    distributionOutboxEvent: { findMany: async () => structuredClone(events) },
    apmsAuditEntry: {
      findUnique: async (q: any) => audits.get(q.where.decisionId) ?? null,
      findMany: async (q: any) => [...audits.values()].filter(a =>
        a.organizationId === q.where.organizationId && a.propertyId === q.where.propertyId &&
        a.entityType === q.where.entityType && a.entityId === q.where.entityId &&
        a.engine === q.where.engine && a.eventType === q.where.eventType &&
        q.where.status.in.includes(a.status)).slice(0, q.take),
      create: async (q: any) => { assert(!audits.has(q.data.decisionId)); audits.set(q.data.decisionId, q.data); return q.data; },
      update: async (q: any) => { Object.assign(audits.get(q.where.decisionId), q.data); return audits.get(q.where.decisionId); },
      updateMany: async (q: any) => {
        let count = 0;
        for (const [decisionId, audit] of audits) {
          if (q.where.decisionId && decisionId !== q.where.decisionId) continue;
          if (q.where.organizationId && audit.organizationId !== q.where.organizationId) continue;
          if (q.where.propertyId && audit.propertyId !== q.where.propertyId) continue;
          if (q.where.entityId && audit.entityId !== q.where.entityId) continue;
          if (q.where.eventType && audit.eventType !== q.where.eventType) continue;
          if (q.where.status?.in && !q.where.status.in.includes(audit.status)) continue;
          Object.assign(audit, q.data); count++;
        }
        return { count };
      },
      upsert: async (q: any) => { if (!audits.has(q.where.decisionId)) audits.set(q.where.decisionId, q.create); return audits.get(q.where.decisionId); },
    },
    $transaction: async (work: any) => work(client),
  };
  const args = { ...scope, now, client,
    readonlyTransport: { getChannel: async (id: string) => { assert.equal(id, channel); gets++; return structuredClone(remote); } },
    activationTransport: { activate: async (id: string) => { assert.equal(id, channel); posts++; remote.data.attributes.is_active = true; } },
    reconcile: async () => { reconciles++; }, channelId: channel, mappingId: mapping, listingId: "551126434553599406",
    confirmation: AIRBNB_ACTIVATION_CONFIRMATION, requestedByUserId: "host-1", requestKey: "activation-12345678" };
  return { args, dp, connection, listing, state, events, remote, audits, queries, writes, counts: () => ({ posts, gets, reconciles }) };
}

test("read-only inspection verifies the existing mapping and completed 500-day ARI pair", async () => {
  const f = fixture();
  assert.equal((await inspectAirbnbActivation(f.args)).status, "READY");
  assert.deepEqual(f.counts(), { posts: 0, gets: 1, reconciles: 0 });
  assert.equal(f.writes.length, 0); assert.equal(f.audits.size, 0);
  assert.deepEqual(f.queries[0].where, { ...scope, platform: "CHANNEX" });
});

test("explicit activation is audited before one POST, verified by GET, and reconciled without forcing ACTIVE", async () => {
  const f = fixture();
  const realActivate = f.args.activationTransport.activate;
  f.args.activationTransport.activate = async id => {
    assert.equal([...f.audits.values()][0].status, "PENDING");
    assert(f.connection.activationRequestedAt);
    await realActivate(id);
  };
  assert.deepEqual(await activateAirbnbForHost(f.args), { outcome: "ACTIVATED", channelActive: true, readinessChecked: true });
  assert.equal(f.counts().posts, 1); assert.equal(f.counts().reconciles, 1);
  assert.equal(f.connection.status, "AUTHORIZATION_REQUIRED");
  assert.equal(f.connection.activationRequestedAt, null);
  assert(f.writes.every(q => Object.keys(q.data).every(k => k === "activationRequestedAt")));
  assert.equal([...f.audits.values()].filter(a => a.eventType === "ACTIVATION_VERIFIED").length, 1);
  assert.equal((await activateAirbnbForHost(f.args)).outcome, "ALREADY_ACTIVE");
  assert.equal(f.counts().posts, 1);
});

test("an already active channel needs no repeated POST or new Full Sync", async () => {
  const f = fixture(); f.remote.data.attributes.is_active = true; f.events.length = 0;
  assert.equal((await activateAirbnbForHost(f.args)).outcome, "ALREADY_ACTIVE");
  assert.equal(f.counts().posts, 0);
});

for (const [name, mutate] of [
  ["missing confirmation", (f: ReturnType<typeof fixture>) => { f.args.confirmation = ""; }],
  ["foreign tenant", (f: ReturnType<typeof fixture>) => { f.dp.organizationId = "org-other"; }],
  ["foreign PMS tenant", (f: ReturnType<typeof fixture>) => { f.listing.connection.organizationId = "org-other"; }],
  ["stale PMS mapping", (f: ReturnType<typeof fixture>) => { f.listing.metadata.channexPropertyId = group; }],
  ["changed channel", (f: ReturnType<typeof fixture>) => { f.remote.data.id = group; }],
  ["changed group", (f: ReturnType<typeof fixture>) => { f.remote.data.relationships.group.data.id = property; }],
  ["changed mapping", (f: ReturnType<typeof fixture>) => { f.remote.data.attributes.rate_plans[0]!.id = group; }],
  ["different listing", (f: ReturnType<typeof fixture>) => { f.remote.data.attributes.rate_plans[0]!.settings.listing_id = "999"; }],
  ["shared channel", (f: ReturnType<typeof fixture>) => { f.remote.data.attributes.properties.push(group); }],
  ["missing mapping", (f: ReturnType<typeof fixture>) => { f.remote.data.attributes.rate_plans.length = 0; }],
  ["wrong adapter", (f: ReturnType<typeof fixture>) => { f.remote.data.attributes.channel = "BookingCom"; }],
  ["disabled distribution", (f: ReturnType<typeof fixture>) => { f.dp.property.distributionEnabled = false; }],
  ["pending previous attempt", (f: ReturnType<typeof fixture>) => { f.connection.activationRequestedAt = now; }],
] as const) test(`${name} prevents activation`, async () => {
  const f = fixture(); mutate(f);
  await assert.rejects(() => activateAirbnbForHost(f.args));
  assert.equal(f.counts().posts, 0); assert.equal(f.writes.length, 0);
});

for (const [name, mutate] of [
  ["warning", (f: ReturnType<typeof fixture>) => { f.events[0]!.delivery.warningCount = 1; }],
  ["not sent", (f: ReturnType<typeof fixture>) => { f.events[1]!.delivery.status = "READY"; }],
  ["different correlation", (f: ReturnType<typeof fixture>) => { f.events[1]!.correlationId = "other"; }],
  ["different mapping", (f: ReturnType<typeof fixture>) => { f.events[0]!.delivery.listingId = "other"; }],
  ["malformed payload", (f: ReturnType<typeof fixture>) => { f.events[0]!.delivery.payload.values.length = 0; }],
  ["tampered payload", (f: ReturnType<typeof fixture>) => { f.events[1]!.delivery.payloadHash = "0".repeat(64); }],
  ["missing day", (f: ReturnType<typeof fixture>) => {
    const d = f.events[1]!.delivery; d.payload.values[0]!.date_to = "2028-01-24";
    Object.assign(d, calculateChannexAriCanonicalJsonIntegrity(d.payload));
  }],
  ["previous-day horizon", (f: ReturnType<typeof fixture>) => {
    for (const event of f.events) {
      event.dateFrom = new Date("2026-09-12"); event.dateToExclusive = new Date("2028-01-25");
      const d = event.delivery; d.dateFrom = event.dateFrom; d.dateToExclusive = event.dateToExclusive;
      d.payload.values[0].date_from = "2026-09-12"; d.payload.values[0].date_to = "2028-01-24";
      Object.assign(d, calculateChannexAriCanonicalJsonIntegrity(d.payload));
    }
  }],
] as const) test(`Full Sync evidence with ${name} blocks POST`, async () => {
  const f = fixture(); mutate(f);
  assert.equal((await inspectAirbnbActivation(f.args)).reason, "FULL_SYNC_REQUIRED");
  await assert.rejects(() => activateAirbnbForHost(f.args));
  assert.equal(f.counts().posts, 0);
});

test("timeout after successful provider mutation recovers through GET, without another POST", async () => {
  const f = fixture(); const send = f.args.activationTransport.activate;
  f.args.activationTransport.activate = async id => { await send(id); throw new AirbnbActivationError("TIMEOUT", true); };
  assert.equal((await activateAirbnbForHost(f.args)).channelActive, true);
  assert.equal(f.counts().posts, 1);
});

test("unknown outcome remains locked, including requests with a new key", async () => {
  const f = fixture(); let sends = 0;
  f.args.activationTransport.activate = async () => { sends++; throw new AirbnbActivationError("TIMEOUT", true); };
  await assert.rejects(() => activateAirbnbForHost(f.args), /RECONCILIATION_REQUIRED/);
  assert.equal([...f.audits.values()][0].status, "UNKNOWN");
  assert.equal((await inspectAirbnbActivation(f.args)).status, "CHECK_REQUIRED");
  f.args.requestKey = "another-key-12345678";
  await assert.rejects(() => activateAirbnbForHost(f.args), /RECONCILIATION_REQUIRED/);
  assert.equal(sends, 1);
});

test("definitive provider rejection is audited and a later explicit attempt can retry", async () => {
  const f = fixture(); const send = f.args.activationTransport.activate;
  f.args.activationTransport.activate = async () => { throw new AirbnbActivationError("OTA_AIRBNB_ACTIVATION_REQUEST_REJECTED"); };
  await assert.rejects(() => activateAirbnbForHost(f.args), /REQUEST_REJECTED/);
  assert.equal(f.connection.activationRequestedAt, null);
  assert.equal([...f.audits.values()][0].status, "FAILED");
  f.args.requestKey = "corrected-12345678"; f.args.activationTransport.activate = send;
  assert.equal((await activateAirbnbForHost(f.args)).outcome, "ACTIVATED");
});

test("concurrent host confirmations claim at most one provider mutation", async () => {
  const f = fixture();
  await Promise.allSettled([activateAirbnbForHost(f.args), activateAirbnbForHost({ ...f.args, requestKey: "other-12345678" })]);
  assert.equal(f.counts().posts, 1);
});

test("a local change while claiming prevents POST", async () => {
  const f = fixture(); const update = f.args.client.otaChannelConnection.updateMany;
  f.args.client.otaChannelConnection.updateMany = async (q: any) => {
    const result = await update(q); f.connection.readinessRevision++; return result;
  };
  await assert.rejects(() => activateAirbnbForHost(f.args), /CONTEXT_CONFLICT/);
  assert.equal(f.counts().posts, 0);
});

test("readiness failure does not turn verified activation into a second mutation", async () => {
  const f = fixture(); f.args.reconcile = async () => { throw new Error("readiness unavailable"); };
  assert.deepEqual(await activateAirbnbForHost(f.args), { outcome: "ACTIVATED", channelActive: true, readinessChecked: false });
  assert.equal(f.counts().posts, 1);
});

test("a successful POST response without an active GET is never reported as activated", async () => {
  const f = fixture(); let sends = 0;
  f.args.activationTransport.activate = async () => { sends++; };
  await assert.rejects(() => activateAirbnbForHost(f.args), /RECONCILIATION_REQUIRED/);
  assert.equal(sends, 1); assert.equal(f.counts().reconciles, 0);
  assert.equal([...f.audits.values()][0].status, "UNKNOWN");
  assert.equal([...f.audits.values()].filter(a => a.eventType === "ACTIVATION_VERIFIED").length, 0);
  assert.equal((await inspectAirbnbActivation(f.args)).status, "CHECK_REQUIRED");
});

test("explicit GET-only verification closes an uncertain audit without another activation POST", async () => {
  const f = fixture();
  let sends = 0;
  f.args.activationTransport.activate = async () => { sends++; throw new AirbnbActivationError("TIMEOUT", true); };
  await assert.rejects(() => activateAirbnbForHost(f.args), /RECONCILIATION_REQUIRED/);
  assert.equal(sends, 1);
  f.remote.data.attributes.is_active = true;
  assert.equal((await inspectAirbnbActivation(f.args)).status, "CHECK_REQUIRED");
  await assert.rejects(() => activateAirbnbForHost({ ...f.args, requestKey: "activation-retry-12345678" }), /RECONCILIATION_REQUIRED/);
  const result = await verifyAirbnbActivationForHost({
    ...f.args,
    confirmation: AIRBNB_ACTIVATION_VERIFICATION_CONFIRMATION,
    requestKey: "verify-activation-12345678",
  });
  assert.deepEqual(result, { outcome: "VERIFIED", channelActive: true, readinessChecked: true });
  assert.equal(sends, 1);
  assert.equal(f.connection.activationRequestedAt, null);
  assert.equal([...f.audits.values()].find(a => a.eventType === "ACTIVATION_REQUESTED")?.status, "SUCCESS");
  assert.equal([...f.audits.values()].filter(a => a.eventType === "ACTIVATION_VERIFIED").length, 1);
});

test("verification while provider is inactive remains uncertain and never repeats activation", async () => {
  const f = fixture();
  let sends = 0;
  f.args.activationTransport.activate = async () => { sends++; throw new AirbnbActivationError("TIMEOUT", true); };
  await assert.rejects(() => activateAirbnbForHost(f.args), /RECONCILIATION_REQUIRED/);
  await assert.rejects(() => verifyAirbnbActivationForHost({
    ...f.args,
    confirmation: AIRBNB_ACTIVATION_VERIFICATION_CONFIRMATION,
    requestKey: "verify-activation-12345678",
  }), /RECONCILIATION_REQUIRED/);
  assert.equal(sends, 1);
  assert.equal([...f.audits.values()][0].status, "UNKNOWN");
});

test("verification cannot close an unresolved request after the provider mapping identity changes", async () => {
  const f = fixture();
  let sends = 0;
  f.args.activationTransport.activate = async () => { sends++; throw new AirbnbActivationError("TIMEOUT", true); };
  await assert.rejects(() => activateAirbnbForHost(f.args), /RECONCILIATION_REQUIRED/);
  const getsBeforeVerification = f.counts().gets;
  const replacementMapping = "77777777-7777-4777-8777-777777777777";
  f.remote.data.attributes.rate_plans[0].id = replacementMapping;
  await assert.rejects(() => verifyAirbnbActivationForHost({
    ...f.args,
    mappingId: replacementMapping,
    confirmation: AIRBNB_ACTIVATION_VERIFICATION_CONFIRMATION,
    requestKey: "verify-activation-12345678",
  }), /RECONCILIATION_REQUIRED/);
  assert.equal(f.counts().gets, getsBeforeVerification);
  assert.equal(sends, 1);
  assert(f.connection.activationRequestedAt);
  assert.equal([...f.audits.values()][0].status, "UNKNOWN");
});

test("verification requires explicit confirmation and one tenant-scoped unresolved audit before provider GET", async () => {
  const missingConfirmation = fixture();
  await assert.rejects(() => verifyAirbnbActivationForHost({
    ...missingConfirmation.args,
    confirmation: "",
    requestKey: "verify-activation-12345678",
  }), /CONFIRMATION_REQUIRED/);
  assert.equal(missingConfirmation.counts().gets, 0);

  const ambiguous = fixture();
  ambiguous.connection.activationRequestedAt = now;
  for (const suffix of ["one", "two"]) ambiguous.audits.set(suffix, {
    ...scope,
    decisionId: suffix,
    entityType: "DISTRIBUTION",
    entityId: ambiguous.connection.id,
    engine: "OTA_DISTRIBUTION",
    eventType: "ACTIVATION_REQUESTED",
    status: "UNKNOWN",
  });
  await assert.rejects(() => verifyAirbnbActivationForHost({
    ...ambiguous.args,
    confirmation: AIRBNB_ACTIVATION_VERIFICATION_CONFIRMATION,
    requestKey: "verify-activation-12345678",
  }), /RECONCILIATION_REQUIRED/);
  assert.equal(ambiguous.counts().gets, 0);
});

test("ambiguous local listings fail before external requests", async () => {
  const f = fixture();
  f.args.client.pmsListing.findMany = async () => [f.listing, { ...f.listing, id: "duplicate" }];
  await assert.rejects(() => activateAirbnbForHost(f.args), /PMS_MAPPING_CONFLICT/);
  assert.deepEqual(f.counts(), { posts: 0, gets: 0, reconciles: 0 });
});
