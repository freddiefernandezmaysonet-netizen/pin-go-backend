import assert from "node:assert/strict";
import test from "node:test";
import {
  AIRBNB_POST_AUTH_AUTOPILOT_FLAG,
  createChannexAirbnbPostAuthProvider,
  parseEnrollment,
  resolveAirbnbPostAuthRuntime,
  runAirbnbPostAuthOwnerCycle,
  runAirbnbPostAuthOwnerOnce,
} from "./airbnb-post-auth-autopilot.owner.js";

const ORG = "cmo1syqey0001p01dlopyf5w5";
const PROPERTY = "cmo1t0gwq000bp01d0wrujlh2";
const CONNECTION = "cmttiomxe0005p51553hxn62i";
const CHANNEL = "04ef2057-cca7-4e28-be54-f991f461a1cd";
const EXT_PROPERTY = "b58de550-63f8-49dc-abfa-4629b94a2160";
const GROUP = "a05d501f-7d1a-40fd-a21e-2805d818e527";
const RATE = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-09-10T15:00:00.000Z");

function enrollment() {
  return {
    organizationId: ORG,
    propertyId: PROPERTY,
    entityType: "DISTRIBUTION",
    entityId: CONNECTION,
    engine: "OTA_AIRBNB_CALLBACK",
    eventType: "CALLBACK_RESOURCE_VERIFIED",
    status: "SUCCESS",
    decisionId: "airbnb-callback-resource:test",
    reason: "CALLBACK_RESOURCE_ONLY",
    metadata: {
      scope: "CALLBACK_RESOURCE_ONLY",
      channelId: CHANNEL,
      requestedByUserId: "user-1",
      activationChanged: false,
      lifecycleStatusChanged: false,
    },
    createdAt: NOW,
  };
}

function context(status = "NOT_CONNECTED", readinessRevision = 0) {
  return {
    connectionId: CONNECTION,
    organizationId: ORG,
    propertyId: PROPERTY,
    provider: "AIRBNB",
    status,
    externalConnectionId: CHANNEL,
    distributionPropertyId: "cmttiomx10003p5153eabavrz",
    distributionPlatform: "CHANNEX",
    distributionProvisioningStatus: "READY",
    externalPropertyId: EXT_PROPERTY,
    externalPrimaryRatePlanId: RATE,
    externalGroupId: GROUP,
    groupPlatform: "CHANNEX",
    groupProvisioningStatus: "READY",
    readinessRevision,
  };
}

function fixture(opts: { listings?: string[]; mapped?: boolean; active?: boolean; readiness?: string[]; status?: string; revision?: number } = {}) {
  const audits = new Map<string, any>();
  const calls = { get: 0, list: 0, map: 0, ready: 0, activate: 0, reconcile: [] as any[] };
  const store = {
    async listCallbackEnrollments() { return [enrollment()]; },
    async loadContext() { return context(opts.status ?? "NOT_CONNECTED", opts.revision ?? 0); },
    async findOwnerAudit(id: string) { return audits.get(id) ?? null; },
    async createOwnerAudit(input: any) {
      if (audits.has(input.decisionId)) return "EXISTS" as const;
      audits.set(input.decisionId, { ...input, createdAt: input.startedAt });
      return "CREATED" as const;
    },
  };
  const provider = {
    async getChannel() {
      calls.get++;
      return {
        id: CHANNEL,
        propertyIds: [EXT_PROPERTY],
        groupId: GROUP,
        isActive: opts.active ?? false,
        mappings: opts.mapped ? [{ id: "11111111-1111-4111-8111-111111111111", ratePlanId: RATE, listingId: "42544559" }] : [],
      };
    },
    async listListings() { calls.list++; return (opts.listings ?? ["42544559"]).map((id) => ({ id, title: "Casa" })); },
    async createMapping() { calls.map++; },
    async checkReadiness() { calls.ready++; return { issues: opts.readiness ?? [] }; },
    async activate() { calls.activate++; },
  };
  const reconcile = async (input: any) => { calls.reconcile.push(input); };
  return { store, provider, reconcile, calls, audits };
}

test("runtime is default-off and invalid values fail closed", () => {
  assert.deepEqual(resolveAirbnbPostAuthRuntime({}), { enabled: false, reason: "DEFAULT_OFF" });
  assert.deepEqual(resolveAirbnbPostAuthRuntime({ [AIRBNB_POST_AUTH_AUTOPILOT_FLAG]: "false" }), { enabled: false, reason: "INVALID_CONFIGURATION" });
});

test("disabled one-shot performs zero owner work", async () => {
  let touched = false;
  const result = await runAirbnbPostAuthOwnerOnce({ env: {}, store: { listCallbackEnrollments: async () => { touched = true; return []; } } as any, provider: {} as any, reconcile: async () => {} });
  assert.equal(result.skipped, true);
  assert.equal(touched, false);
});

test("strict callback enrollment parser rejects changed-lifecycle evidence", () => {
  const bad = enrollment();
  (bad.metadata as any).activationChanged = true;
  assert.equal(parseEnrollment(bad), null);
});

test("single listing creates exactly one mapping and stops", async () => {
  const f = fixture();
  const r = await runAirbnbPostAuthOwnerCycle({ ...f, limit: 5, settleMs: 120000, now: NOW });
  assert.equal(r.providerMutations, 1);
  assert.equal(f.calls.map, 1);
  assert.equal(f.calls.activate, 0);
  assert.equal(r.items[0]?.reason, "MAPPING_CREATED");
});

test("multiple listings fail closed without mutation", async () => {
  const f = fixture({ listings: ["1", "2"] });
  const r = await runAirbnbPostAuthOwnerCycle({ ...f, limit: 5, settleMs: 120000, now: NOW });
  assert.equal(r.providerMutations, 0);
  assert.equal(f.calls.map, 0);
  assert.equal(r.items[0]?.reason, "MULTIPLE_LISTINGS");
});

test("mapped channel with readiness blockers does not activate", async () => {
  const f = fixture({ mapped: true, readiness: ["Channel:Mapping:required"], revision: 7 });
  const r = await runAirbnbPostAuthOwnerCycle({ ...f, limit: 5, settleMs: 120000, now: NOW });
  assert.equal(f.calls.activate, 0);
  assert.equal(f.calls.reconcile[0].requestKey, `airbnb-post-auth:${CONNECTION}:r7`);
  assert.equal(r.items[0]?.reason, "READINESS_PENDING");
});

test("ready mapped channel requests activation exactly once", async () => {
  const f = fixture({ mapped: true });
  const r = await runAirbnbPostAuthOwnerCycle({ ...f, limit: 5, settleMs: 120000, now: NOW });
  assert.equal(r.providerMutations, 1);
  assert.equal(f.calls.activate, 1);
  assert.equal(r.items[0]?.reason, "ACTIVATION_REQUESTED");
});

test("provider-active channel only reconciles; owner never sets canonical ACTIVE", async () => {
  const f = fixture({ active: true, revision: 3 });
  const r = await runAirbnbPostAuthOwnerCycle({ ...f, limit: 5, settleMs: 120000, now: NOW });
  assert.equal(f.calls.activate, 0);
  assert.equal(f.calls.reconcile.length, 1);
  assert.equal(f.calls.reconcile[0].requestKey, `airbnb-post-auth:${CONNECTION}:r3`);
  assert.equal(r.items[0]?.outcome, "WAIT_CANONICAL");
});

test("canonical ACTIVE skips provider entirely", async () => {
  const f = fixture({ status: "ACTIVE" });
  const r = await runAirbnbPostAuthOwnerCycle({ ...f, limit: 5, settleMs: 120000, now: NOW });
  assert.equal(f.calls.get, 0);
  assert.equal(r.items[0]?.outcome, "ACTIVE");
});

test("transport rejects non-Channex origin before network", () => {
  assert.throws(() => createChannexAirbnbPostAuthProvider({ apiOrigin: "https://evil.example", apiKey: "x" }), /PROVIDER_ORIGIN_INVALID/);
});
