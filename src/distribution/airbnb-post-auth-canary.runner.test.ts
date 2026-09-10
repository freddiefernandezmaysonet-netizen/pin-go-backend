import assert from "node:assert/strict";
import test from "node:test";

import {
  AIRBNB_MAPPING_CANARY_CONFIRMATION,
  AirbnbPostAuthCanaryError,
  assertAirbnbMappingCanaryEnvironment,
  createMappingOnlyCanaryProvider,
  parseAirbnbMappingCanaryArgs,
  runAirbnbPostAuthMappingCanary,
  type AirbnbMappingCanaryTarget,
} from "./airbnb-post-auth-canary.runner.js";

const TARGET: AirbnbMappingCanaryTarget = {
  organizationId: "cmo1syqey0001p01dlopyf5w5",
  propertyId: "cmo1t0gwq000bp01d0wrujlh2",
  connectionId: "cmttiomxe0005p51553hxn62i",
  channelId: "04ef2057-cca7-4e28-be54-f991f461a1cd",
  externalPropertyId: "b58de550-63f8-49dc-abfa-4629b94a2160",
  externalGroupId: "a05d501f-7d1a-40fd-a21e-2805d818e527",
  ratePlanId: "bfd7dfe7-0c6d-4145-bbc4-45546780d720",
  listingId: "551126434553599406",
};

function args() {
  return [
    "--mode=mapping-only",
    `--confirm=${AIRBNB_MAPPING_CANARY_CONFIRMATION}`,
    `--organization-id=${TARGET.organizationId}`,
    `--property-id=${TARGET.propertyId}`,
    `--connection-id=${TARGET.connectionId}`,
    `--channel-id=${TARGET.channelId}`,
    `--external-property-id=${TARGET.externalPropertyId}`,
    `--external-group-id=${TARGET.externalGroupId}`,
    `--rate-plan-id=${TARGET.ratePlanId}`,
    `--listing-id=${TARGET.listingId}`,
  ];
}

function provider(overrides: Partial<any> = {}) {
  const calls = { get: 0, list: 0, map: 0, ready: 0, activate: 0 };
  const base = {
    async getChannel() {
      calls.get += 1;
      return {
        id: TARGET.channelId,
        propertyIds: [TARGET.externalPropertyId],
        groupId: TARGET.externalGroupId,
        isActive: false,
        mappings: [],
      };
    },
    async listListings() {
      calls.list += 1;
      return [{ id: TARGET.listingId, title: "Casa Collores" }];
    },
    async createMapping() {
      calls.map += 1;
    },
    async checkReadiness() {
      calls.ready += 1;
      return { issues: [] };
    },
    async activate() {
      calls.activate += 1;
    },
    ...overrides,
  };
  return { base, calls };
}

function store() {
  const now = new Date("2026-09-10T16:30:00.000Z");
  const audits = new Map<string, any>();
  return {
    async listCallbackEnrollments(limit: number) {
      assert.equal(limit, 1);
      return [
        {
          organizationId: TARGET.organizationId,
          propertyId: TARGET.propertyId,
          entityType: "DISTRIBUTION",
          entityId: TARGET.connectionId,
          engine: "OTA_AIRBNB_CALLBACK",
          eventType: "CALLBACK_RESOURCE_VERIFIED",
          status: "SUCCESS",
          decisionId: "airbnb-callback-resource:test",
          reason: "CALLBACK_RESOURCE_ONLY",
          metadata: {
            scope: "CALLBACK_RESOURCE_ONLY",
            channelId: TARGET.channelId,
            requestedByUserId: "canary-user",
            activationChanged: false,
            lifecycleStatusChanged: false,
          },
          createdAt: now,
        },
      ];
    },
    async loadContext() {
      return {
        connectionId: TARGET.connectionId,
        organizationId: TARGET.organizationId,
        propertyId: TARGET.propertyId,
        provider: "AIRBNB",
        status: "NOT_CONNECTED",
        externalConnectionId: TARGET.channelId,
        distributionPropertyId: "cmttiomx10003p5153eabavrz",
        distributionPlatform: "CHANNEX",
        distributionProvisioningStatus: "READY",
        externalPropertyId: TARGET.externalPropertyId,
        externalPrimaryRatePlanId: TARGET.ratePlanId,
        externalGroupId: TARGET.externalGroupId,
        groupPlatform: "CHANNEX",
        groupProvisioningStatus: "READY",
        readinessRevision: 0,
      };
    },
    async findOwnerAudit(decisionId: string) {
      return audits.get(decisionId) ?? null;
    },
    async createOwnerAudit(input: any) {
      if (audits.has(input.decisionId)) return "EXISTS" as const;
      audits.set(input.decisionId, { ...input, createdAt: input.startedAt });
      return "CREATED" as const;
    },
  };
}

test("parses only exact mapping-only canary arguments", () => {
  assert.deepEqual(parseAirbnbMappingCanaryArgs(args()), TARGET);
  assert.throws(
    () => parseAirbnbMappingCanaryArgs(args().filter((x) => !x.startsWith("--confirm="))),
    (error: unknown) =>
      error instanceof AirbnbPostAuthCanaryError &&
      error.code === "CANARY_CONFIRMATION_REQUIRED"
  );
  assert.throws(
    () => parseAirbnbMappingCanaryArgs([...args(), "--extra=x"]),
    (error: unknown) =>
      error instanceof AirbnbPostAuthCanaryError &&
      error.code === "CANARY_ARGUMENT_INVALID"
  );
});

test("requires production Channex and global autopilot OFF", () => {
  assert.doesNotThrow(() =>
    assertAirbnbMappingCanaryEnvironment(
      { NODE_ENV: "production" },
      "https://app.channex.io"
    )
  );
  assert.throws(
    () =>
      assertAirbnbMappingCanaryEnvironment(
        { NODE_ENV: "production", OTA_AIRBNB_POST_AUTH_AUTOPILOT_ENABLED: "true" },
        "https://app.channex.io"
      ),
    /CANARY_GLOBAL_AUTOPILOT_MUST_BE_OFF/
  );
  assert.throws(
    () =>
      assertAirbnbMappingCanaryEnvironment(
        { NODE_ENV: "production" },
        "https://staging.channex.io"
      ),
    /CANARY_REQUIRES_PRODUCTION_CHANNEX/
  );
});

test("mapping-only provider rejects changed preflight state", async () => {
  const p = provider({
    async getChannel() {
      return {
        id: TARGET.channelId,
        propertyIds: [TARGET.externalPropertyId],
        groupId: TARGET.externalGroupId,
        isActive: false,
        mappings: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            ratePlanId: TARGET.ratePlanId,
            listingId: TARGET.listingId,
          },
        ],
      };
    },
  });
  const guarded = createMappingOnlyCanaryProvider(p.base as any, TARGET);
  await assert.rejects(
    () => guarded.getChannel(TARGET.channelId),
    /CANARY_PREFLIGHT_STATE_CHANGED/
  );
});

test("mapping-only provider rejects listing drift", async () => {
  const p = provider({
    async listListings() {
      return [{ id: "999999", title: "Other" }];
    },
  });
  const guarded = createMappingOnlyCanaryProvider(p.base as any, TARGET);
  await assert.rejects(
    () => guarded.listListings(TARGET.channelId),
    /CANARY_LISTING_STATE_CHANGED/
  );
});

test("successful canary performs exactly one mapping and no readiness, reconcile or activation", async () => {
  const p = provider();
  const result = await runAirbnbPostAuthMappingCanary({
    target: TARGET,
    store: store() as any,
    provider: p.base as any,
    now: new Date("2026-09-10T16:31:00.000Z"),
  });

  assert.deepEqual(result, {
    outcome: "MAPPING_ACCEPTED_WAIT_PROVIDER",
    channelId: TARGET.channelId,
    ratePlanId: TARGET.ratePlanId,
    listingId: TARGET.listingId,
    providerMutations: 1,
  });
  assert.equal(p.calls.get, 1);
  assert.equal(p.calls.list, 1);
  assert.equal(p.calls.map, 1);
  assert.equal(p.calls.ready, 0);
  assert.equal(p.calls.activate, 0);
});

test("provider mutation failure does not permit a second write", async () => {
  let calls = 0;
  const p = provider({
    async createMapping() {
      calls += 1;
      throw new Error("provider failed");
    },
  });

  await assert.rejects(
    () =>
      runAirbnbPostAuthMappingCanary({
        target: TARGET,
        store: store() as any,
        provider: p.base as any,
      }),
    /CANARY_UNEXPECTED_OUTCOME/
  );
  assert.equal(calls, 1);
});
