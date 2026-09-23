import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { createInitialDistributionEnablement } from "./ota-initial-distribution-enablement.service.js";

const input = { organizationId: "org-1", propertyId: "property-1", requestedByUserId: "user-1" };
const now = new Date("2026-09-23T18:00:00.000Z");
const uuid = (last: string) => `11111111-1111-4111-8111-${last.padStart(12, "0")}`;
function fixture() {
  const property = { id: input.propertyId, organizationId: input.organizationId, status: "ACTIVE",
    timezone: "America/Puerto_Rico", updatedAt: new Date(now.getTime() - 1000),
    distributionEnabled: false, distributionStatus: "DISABLED", distributionEnabledAt: null,
    distributionLastSyncedAt: null, distributionLastError: null };
  let state: any = {
    property,
    actor: { id: input.requestedByUserId, organizationId: input.organizationId, isActive: true, role: "ORG_ADMIN" },
    distribution: { id: "dp-1", propertyId: input.propertyId, organizationId: input.organizationId,
      groupId: "group-1", platform: "CHANNEX", provisioningStatus: "READY", lastErrorCode: null,
      externalPropertyId: uuid("1"), externalPrimaryRoomTypeId: uuid("2"), externalPrimaryRatePlanId: uuid("3"),
      group: { id: "group-1", organizationId: input.organizationId, platform: "CHANNEX",
        provisioningStatus: "READY", externalGroupId: uuid("4") } },
    listings: [{ id: "listing-1", propertyId: input.propertyId, connectionId: "connection-1", externalListingId: uuid("2"),
      connection: { id: "connection-1", organizationId: input.organizationId, provider: "CHANNEX", status: "ACTIVE" },
      metadata: { provider: "CHANNEX", channexPropertyId: uuid("1"), channexRatePlanId: uuid("3") } }],
    audits: [], ari: null, outbox: null,
  };
  const writes: any[] = [], queries: any[] = [], transactions: any[] = [];
  const faults = { audit: false, count: 1, serialization: false };
  const client: any = {
    dashboardUser: { findFirst: async (q: any) => { queries.push(["actor", q]); return structuredClone(state.actor); } },
    property: {
      findFirst: async (q: any) => { queries.push(["property", q]); return structuredClone(state.property); },
      updateMany: async (q: any) => {
        writes.push(["property", q]);
        const matches = Object.entries(q.where).every(([key, value]) =>
          value instanceof Date ? state.property[key]?.getTime() === value.getTime() : state.property[key] === value);
        if (!matches || faults.count !== 1) return { count: faults.count === 1 ? 0 : faults.count };
        Object.assign(state.property, q.data, { updatedAt: now });
        return { count: 1 };
      },
    },
    distributionProperty: { findFirst: async (q: any) => { queries.push(["distribution", q]); return structuredClone(state.distribution); } },
    pmsListing: { findMany: async (q: any) => { queries.push(["listings", q]); return structuredClone(state.listings); } },
    channexAriPropertyState: { findUnique: async (q: any) => { queries.push(["ari", q]); return structuredClone(state.ari); } },
    distributionOutboxEvent: { findFirst: async (q: any) => { queries.push(["outbox", q]); return structuredClone(state.outbox); } },
    apmsAuditEntry: {
      findUnique: async (q: any) => { queries.push(["audit", q]); return state.audits.find((a: any) => a.decisionId === q.where.decisionId) ?? null; },
      create: async (q: any) => { if (faults.audit) throw new Error("secret-bearing-database-error");
        writes.push(["audit", q]); assert.ok(!state.audits.some((a: any) => a.decisionId === q.data.decisionId));
        state.audits.push({ id: "audit-1", ...structuredClone(q.data) }); return { id: "audit-1" }; },
    },
    $transaction: async (work: (tx: any) => Promise<any>, options: any) => {
      transactions.push(options); const before = structuredClone(state);
      try { const result = await work(client); if (faults.serialization) throw new Error("P2034"); return result; }
      catch (error) { state = before; throw error; }
    },
  };
  return {
    client: client as PrismaClient, hooks: createInitialDistributionEnablement(client, () => now),
    get state() { return state; }, writes, queries, transactions, faults,
    verify() { Object.assign(state.listings[0].metadata, { channexBookingWebhookVerified: true,
      channexBookingWebhookId: uuid("5"), channexBookingWebhookEventMask: "booking",
      channexBookingWebhookSendData: false, channexBookingWebhookConfiguredAt: now.toISOString() }); },
  };
}

test("READY inventory + never-enabled property completes only the internal transition", async () => {
  const f = fixture(), inventory = structuredClone(f.state.distribution);
  await f.hooks.preflight(input);
  const guard = await f.hooks.capture(input);
  assert.ok(guard); assert.equal(f.writes.length, 0);
  f.verify(); const listing = structuredClone(f.state.listings);
  await f.hooks.complete(input, guard);
  assert.equal(f.state.property.distributionEnabled, true);
  assert.equal(f.state.property.distributionStatus, "ACTIVE");
  assert.deepEqual(f.state.property.distributionEnabledAt, now);
  assert.equal(f.state.property.distributionLastSyncedAt, null);
  assert.deepEqual(f.state.distribution, inventory);
  assert.deepEqual(f.state.listings, listing);
  assert.deepEqual(f.writes.map(x => x[0]), ["property", "audit"]);
  assert.equal(f.state.audits[0].metadata.otaActivationPerformed, false);
  assert.equal(f.state.audits[0].metadata.fullSyncRequested, false);
  assert.ok(f.transactions.every(q => q.isolationLevel === "Serializable"));
  const write = f.writes[0][1];
  assert.equal(write.where.organizationId, input.organizationId);
  assert.equal(write.where.distributionEnabledAt, null);
  assert.deepEqual(Object.keys(write.data).sort(), ["distributionEnabled", "distributionEnabledAt", "distributionStatus"]);
});

test("repeated preparation and completion are idempotent; already-active properties are not rewritten", async () => {
  const f = fixture(); const a = await f.hooks.capture(input), b = await f.hooks.capture(input);
  f.verify(); await f.hooks.complete(input, a); const before = structuredClone(f.state);
  await f.hooks.complete(input, b); await f.hooks.preflight(input);
  assert.equal(await f.hooks.capture(input), null); await f.hooks.complete(input, null);
  assert.deepEqual(f.state, before); assert.equal(f.writes.length, 2);
});

test("pre-existing ACTIVE without a new audit is a no-op", async () => {
  const f = fixture(); f.state.property.distributionEnabled = true; f.state.property.distributionStatus = "ACTIVE";
  f.state.property.distributionEnabledAt = new Date("2026-08-01");
  f.state.distribution = null;
  const before = structuredClone(f.state);
  await f.hooks.preflight(input); await f.hooks.complete(input, await f.hooks.capture(input));
  assert.deepEqual(f.state, before); assert.equal(f.writes.length, 0);
});

test("previous lifecycle, intentional disable markers and inconsistent states fail closed", async t => {
  const scenarios: Record<string, (f: ReturnType<typeof fixture>) => void> = {
    "previous enablement": f => { f.state.property.distributionEnabledAt = now; },
    "previous sync": f => { f.state.property.distributionLastSyncedAt = now; },
    "previous error": f => { f.state.property.distributionLastError = "host review"; },
    "FAILED": f => { f.state.property.distributionStatus = "FAILED"; },
    "PAUSED": f => { f.state.property.distributionStatus = "PAUSED"; },
    "true DISABLED": f => { f.state.property.distributionEnabled = true; },
    "false ACTIVE": f => { f.state.property.distributionStatus = "ACTIVE"; },
    "existing queued intent": f => { f.state.outbox = { id: "intent-1" }; },
    "previous ARI sync": f => { f.state.ari = { organizationId: input.organizationId, lastFullSyncRequestedAt: now, lastFullSyncCompletedAt: null }; },
    "foreign ARI state": f => { f.state.ari = { organizationId: "other", lastFullSyncRequestedAt: null, lastFullSyncCompletedAt: null }; },
  };
  for (const [name, mutate] of Object.entries(scenarios)) await t.test(name, async () => {
    const f = fixture(); mutate(f); const before = structuredClone(f.state);
    await assert.rejects(f.hooks.preflight(input), /REVIEW_REQUIRED/);
    assert.deepEqual(f.state, before); assert.equal(f.writes.length, 0);
  });
});

test("prior initial audit blocks re-enablement even when property history fields were cleared", async () => {
  const f = fixture(), guard = await f.hooks.capture(input); f.verify(); await f.hooks.complete(input, guard);
  Object.assign(f.state.property, { distributionEnabled: false, distributionStatus: "DISABLED", distributionEnabledAt: null });
  await assert.rejects(f.hooks.preflight(input), /REVIEW_REQUIRED/);
  assert.equal(f.state.property.distributionEnabled, false);
});

test("scope, actor and timezone checks precede mutations", async t => {
  const scenarios: Record<string, (f: ReturnType<typeof fixture>) => void> = {
    "missing actor": f => { f.state.actor = null; },
    "foreign actor": f => { f.state.actor.organizationId = "other"; },
    "non-admin actor": f => { f.state.actor.role = "STAFF"; },
    "disabled actor": f => { f.state.actor.isActive = false; },
    "foreign property": f => { f.state.property.organizationId = "other"; },
    "archived property": f => { f.state.property.status = "ARCHIVED"; },
    "missing timezone": f => { f.state.property.timezone = null; },
    "invalid timezone": f => { f.state.property.timezone = "not-a-timezone"; },
  };
  for (const [name, mutate] of Object.entries(scenarios)) await t.test(name, async () => {
    const f = fixture(); mutate(f); await assert.rejects(f.hooks.preflight(input), /OTA_INITIAL_DISTRIBUTION_/);
    assert.equal(f.writes.length, 0);
  });
  await assert.rejects(fixture().hooks.preflight({ ...input, propertyId: " " }), /SCOPE_INVALID/);
});

test("incomplete, foreign and mismatched inventory cannot produce an enablement guard", async t => {
  const scenarios: Record<string, (f: ReturnType<typeof fixture>) => void> = {
    "missing distribution": f => { f.state.distribution = null; },
    "provisioning pending": f => { f.state.distribution.provisioningStatus = "PROVISIONING"; },
    "provisioning error": f => { f.state.distribution.lastErrorCode = "FAILED"; },
    "group not ready": f => { f.state.distribution.group.provisioningStatus = "FAILED"; },
    "foreign group": f => { f.state.distribution.group.organizationId = "other"; },
    "invalid identifier": f => { f.state.distribution.externalPrimaryRatePlanId = "invalid"; },
    "no listing": f => { f.state.listings = []; },
    "ambiguous listing": f => { f.state.listings.push(structuredClone(f.state.listings[0])); },
    "foreign connection": f => { f.state.listings[0].connection.organizationId = "other"; },
    "inactive connection": f => { f.state.listings[0].connection.status = "DISABLED"; },
    "property mismatch": f => { f.state.listings[0].metadata.channexPropertyId = uuid("9"); },
    "room mismatch": f => { f.state.listings[0].externalListingId = uuid("9"); },
    "rate mismatch": f => { f.state.listings[0].metadata.channexRatePlanId = uuid("9"); },
  };
  for (const [name, mutate] of Object.entries(scenarios)) await t.test(name, async () => {
    const f = fixture(); mutate(f); await assert.rejects(f.hooks.capture(input), /OTA_INITIAL_DISTRIBUTION_/);
    assert.equal(f.writes.length, 0);
  });
});

test("verification must be successful, fresh and for the booking registrar", async t => {
  const scenarios: Record<string, (f: ReturnType<typeof fixture>) => void> = {
    "not verified": f => { f.state.listings[0].metadata.channexBookingWebhookVerified = false; },
    "missing timestamp": f => { delete f.state.listings[0].metadata.channexBookingWebhookConfiguredAt; },
    "stale timestamp": f => { f.state.listings[0].metadata.channexBookingWebhookConfiguredAt = new Date(now.getTime() - 1).toISOString(); },
    "future timestamp": f => { f.state.listings[0].metadata.channexBookingWebhookConfiguredAt = new Date(now.getTime() + 1).toISOString(); },
    "wrong event mask": f => { f.state.listings[0].metadata.channexBookingWebhookEventMask = "channel"; },
    "wrong send data": f => { f.state.listings[0].metadata.channexBookingWebhookSendData = true; },
    "missing webhook id": f => { delete f.state.listings[0].metadata.channexBookingWebhookId; },
  };
  for (const [name, mutate] of Object.entries(scenarios)) await t.test(name, async () => {
    const f = fixture(), guard = await f.hooks.capture(input); f.verify(); mutate(f);
    await assert.rejects(f.hooks.complete(input, guard), /WEBHOOK_NOT_VERIFIED/); assert.equal(f.writes.length, 0);
  });
});

test("changes during external verification fail closed without re-enabling or remapping", async t => {
  for (const change of ["property", "identity", "actor", "disable"] as const) await t.test(change, async () => {
    const f = fixture(), guard = await f.hooks.capture(input); f.verify();
    if (change === "property") f.state.property.updatedAt = now;
    if (change === "identity") { f.state.distribution.externalPrimaryRatePlanId = uuid("9"); f.state.listings[0].metadata.channexRatePlanId = uuid("9"); }
    if (change === "actor") f.state.actor.isActive = false;
    if (change === "disable") f.state.property.distributionEnabledAt = now;
    const before = structuredClone(f.state);
    await assert.rejects(f.hooks.complete(input, guard), /OTA_INITIAL_DISTRIBUTION_/);
    assert.deepEqual(f.state, before); assert.equal(f.writes.length, 0);
  });
});

test("audit, compare-and-set and serialization failures roll back and sanitize errors", async t => {
  for (const fault of ["audit", "count", "serialization"] as const) await t.test(fault, async () => {
    const f = fixture(), guard = await f.hooks.capture(input); f.verify();
    if (fault === "count") f.faults.count = 0; else f.faults[fault] = true;
    const before = structuredClone(f.state);
    await assert.rejects(f.hooks.complete(input, guard), (error: any) => {
      assert.match(error.code, /OTA_INITIAL_DISTRIBUTION_(PERSISTENCE|STATE)_CONFLICT/);
      assert.doesNotMatch(error.message, /secret-bearing|P2034/); return true;
    });
    assert.deepEqual(f.state, before);
  });
});

async function compositionFixture(f: ReturnType<typeof fixture>, failure?: "booking" | "lifecycle" | "mapping") {
  const { buildOtaConnectionCenterComposition } = await import("./ota-connection-center.composition.js");
  const calls: string[] = [];
  const distribution = f.state.distribution;
  const actions = buildOtaConnectionCenterComposition({
    prisma: f.client, runtimeValue: "true", defaultCurrency: "USD",
    trustedMutationOrigins: ["https://app.pin-ngo.com"], allowedLaunchOrigins: ["https://app.channex.io"],
    initialDistributionEnablement: f.hooks,
    repository: {
      loadTenantSnapshot: async () => ({ organizationId: input.organizationId, propertyId: input.propertyId,
        groupStatus: "READY", propertyStatus: "READY" }),
      alignPmsListingToReadyDistributionMapping: async () => {
        calls.push("mapping"); if (failure === "mapping") throw new Error("MOCK_MAPPING_FAILURE"); return "ALREADY_ALIGNED";
      },
    } as any,
    prepareLogicalConnection: async () => { calls.push("prepare"); return {} as any; },
    adapter: {
      ensureGroup: async () => { throw new Error("Do not reprovision ready group"); },
      ensureProperty: async () => { throw new Error("Do not reprovision ready property"); },
      ensurePrimaryRoomType: async () => { throw new Error("Do not reprovision ready room"); },
      ensurePrimaryRatePlan: async () => { throw new Error("Do not reprovision ready rate"); },
      issue: async () => { throw new Error("Do not create an OTA session"); },
    },
    configureBookingWebhook: async () => {
      calls.push("booking"); assert.equal(f.state.property.distributionEnabled, false);
      if (failure === "booking") return { verified: false };
      f.verify(); return { verified: true };
    },
    configureChannelLifecycleWebhook: async () => {
      calls.push("lifecycle"); assert.equal(f.state.property.distributionEnabled, false);
      return { verified: failure !== "lifecycle" };
    },
  });
  assert.equal(f.state.distribution, distribution);
  return { actions, calls };
}

test("composition enables READY inventory only after both verifications, using mocked I/O", async () => {
  const f = fixture(), { actions, calls } = await compositionFixture(f);
  assert.deepEqual(await actions.prepare!({ ...input, provider: "AIRBNB", requestKey: "initial-1" }), { provisioningStatus: "READY" });
  assert.deepEqual(calls, ["prepare", "mapping", "booking", "lifecycle"]);
  assert.equal(f.state.property.distributionEnabled, true); assert.equal(f.state.audits.length, 1);
});

test("composition does not enable on mapping or webhook failure", async t => {
  for (const failure of ["mapping", "booking", "lifecycle"] as const) await t.test(failure, async () => {
    const f = fixture(), { actions } = await compositionFixture(f, failure);
    await assert.rejects(actions.prepare!({ ...input, provider: "VRBO", requestKey: "initial-failure" }));
    assert.equal(f.state.property.distributionEnabled, false); assert.equal(f.writes.length, 0);
  });
});

test("composition rejects previously disabled properties before provisioning or registrar I/O", async () => {
  const f = fixture(); f.state.property.distributionEnabledAt = now;
  const { actions, calls } = await compositionFixture(f);
  await assert.rejects(actions.prepare!({ ...input, provider: "EXPEDIA", requestKey: "disabled" }), /REVIEW_REQUIRED/);
  assert.deepEqual(calls, []); assert.equal(f.writes.length, 0);
});

test("runtime wires first-enablement into prepare and remains inert until an authenticated call", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./ota-connection-center.runtime-composition.ts", import.meta.url), "utf8");
  assert.match(source, /initialDistributionEnablement:\s*createInitialDistributionEnablement\(args\.prisma\)/);
  const { buildRuntimeOtaConnectionCenterComposition } = await import("./ota-connection-center.runtime-composition.js");
  const f = fixture();
  const disabled = buildRuntimeOtaConnectionCenterComposition({ prisma: f.client, env: {}, trustedMutationOrigins: [] });
  assert.equal(disabled.prepare, undefined); assert.equal(f.queries.length, 0); assert.equal(f.writes.length, 0);
});
