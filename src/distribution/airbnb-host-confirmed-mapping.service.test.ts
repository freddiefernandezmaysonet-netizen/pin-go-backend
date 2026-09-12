import assert from "node:assert/strict";
import test from "node:test";

import {
  AIRBNB_HOST_MAPPING_CONFIRMATION,
  AirbnbHostConfirmedMappingError,
  confirmAirbnbHostMapping,
} from "./airbnb-host-confirmed-mapping.service.js";

const ORGANIZATION_ID = "org-1";
const PROPERTY_ID = "property-1";
const DISTRIBUTION_PROPERTY_ID = "distribution-property-1";
const CHANNEL_ID = "04ef2057-cca7-4e28-be54-f991f461a1cd";
const EXTERNAL_PROPERTY_ID = "b58de550-63f8-49dc-abfa-4629b94a2160";
const GROUP_ID = "a05d501f-7d1a-40fd-a21e-2805d818e527";
const RATE_PLAN_ID = "bfd7dfe7-0c6d-4145-bbc4-45546780d720";
const LISTING_ID = "551126434553599406";
const MAPPING_ID = "11111111-1111-4111-8111-111111111111";

function localContext(overrides: { connection?: Record<string, unknown>; distribution?: Record<string, unknown> } = {}) {
  const reads = { distribution: 0, connection: 0 };
  const distribution = {
    id: DISTRIBUTION_PROPERTY_ID,
    organizationId: ORGANIZATION_ID,
    propertyId: PROPERTY_ID,
    platform: "CHANNEX",
    provisioningStatus: "READY",
    externalPropertyId: EXTERNAL_PROPERTY_ID,
    externalPrimaryRatePlanId: RATE_PLAN_ID,
    group: {
      organizationId: ORGANIZATION_ID,
      platform: "CHANNEX",
      provisioningStatus: "READY",
      externalGroupId: GROUP_ID,
    },
    ...(overrides.distribution ?? {}),
  };
  const connection = {
    id: "connection-1",
    organizationId: ORGANIZATION_ID,
    propertyId: PROPERTY_ID,
    distributionPropertyId: DISTRIBUTION_PROPERTY_ID,
    provider: "AIRBNB",
    status: "NOT_CONNECTED",
    externalConnectionId: CHANNEL_ID,
    ...(overrides.connection ?? {}),
  };
  return {
    reads,
    client: {
      distributionProperty: {
        async findFirst() {
          reads.distribution += 1;
          return distribution as any;
        },
      },
      otaChannelConnection: {
        async findFirst() {
          reads.connection += 1;
          return connection as any;
        },
      },
    },
  };
}

function discovery(overrides: Record<string, unknown> = {}) {
  return {
    channelId: CHANNEL_ID,
    listings: [
      {
        id: LISTING_ID,
        title: "Casa Collores",
        type: "house",
        occupancies: [1, 2],
        synchronizationCategory: null,
        city: "Collores",
        countryCode: "PR",
        qualityStatus: null,
      },
    ],
    match: {
      propertyId: PROPERTY_ID,
      status: "REVIEW_REQUIRED" as const,
      confidence: "HIGH" as const,
      candidateListingId: LISTING_ID,
      candidateTitle: "Casa Collores",
      score: 80,
      runnerUpScore: null,
      reasons: ["NAME_EXACT", "CITY_MISMATCH", "COUNTRY_MATCH", "DETAILS_UNAVAILABLE"],
      ...(overrides.match as Record<string, unknown> | undefined),
    },
    ...overrides,
  } as any;
}

function channelPayload(mappings: Array<{ id: string; ratePlanId: string; listingId: string }> = [], isActive = false) {
  return {
    data: {
      type: "channel",
      id: CHANNEL_ID,
      attributes: {
        id: CHANNEL_ID,
        channel: "Airbnb",
        is_active: isActive,
        properties: [EXTERNAL_PROPERTY_ID],
        rate_plans: mappings.map((mapping) => ({
          id: mapping.id,
          rate_plan_id: mapping.ratePlanId,
          settings: { listing_id: mapping.listingId },
        })),
      },
      relationships: {
        group: { data: { type: "group", id: GROUP_ID } },
      },
    },
  };
}

function mappingResponse() {
  return {
    data: {
      type: "channel_rate_plan",
      id: CHANNEL_ID,
      attributes: {
        id: MAPPING_ID,
        settings: { listing_id: LISTING_ID },
      },
      relationships: {
        channel: { data: { type: "channel", id: CHANNEL_ID } },
      },
    },
  };
}

function harness(args: { channel?: unknown; discovery?: unknown; local?: ReturnType<typeof localContext> } = {}) {
  const local = args.local ?? localContext();
  const calls = { discover: 0, getChannel: 0, createMapping: 0 };
  return {
    local,
    calls,
    dependencies: {
      client: local.client,
      readonlyTransport: {
        async getChannel() {
          calls.getChannel += 1;
          return args.channel ?? channelPayload();
        },
      },
      mappingTransport: {
        async createMapping(input: unknown) {
          calls.createMapping += 1;
          assert.deepEqual(input, {
            channelId: CHANNEL_ID,
            ratePlanId: RATE_PLAN_ID,
            listingId: LISTING_ID,
          });
          return mappingResponse();
        },
      },
      async discoverListings() {
        calls.discover += 1;
        return (args.discovery ?? discovery()) as any;
      },
    },
  };
}

async function execute(h = harness(), overrides: Record<string, unknown> = {}) {
  return confirmAirbnbHostMapping({
    ...h.dependencies,
    organizationId: ORGANIZATION_ID,
    propertyId: PROPERTY_ID,
    listingId: LISTING_ID,
    confirmation: AIRBNB_HOST_MAPPING_CONFIRMATION,
    ...overrides,
  } as any);
}

test("requires explicit host confirmation before any local or provider access", async () => {
  const h = harness();
  await assert.rejects(
    execute(h, { confirmation: "yes" }),
    (error: unknown) =>
      error instanceof AirbnbHostConfirmedMappingError &&
      error.code === "OTA_AIRBNB_MAPPING_EXPLICIT_CONFIRMATION_REQUIRED"
  );
  assert.deepEqual(h.local.reads, { distribution: 0, connection: 0 });
  assert.deepEqual(h.calls, { discover: 0, getChannel: 0, createMapping: 0 });
});

test("submits exactly one mapping after tenant, candidate and channel fencing", async () => {
  const h = harness();
  const result = await execute(h);
  assert.deepEqual(result, {
    outcome: "MAPPING_SUBMITTED",
    listingId: LISTING_ID,
    mappingId: MAPPING_ID,
  });
  assert.deepEqual(h.local.reads, { distribution: 1, connection: 1 });
  assert.deepEqual(h.calls, { discover: 1, getChannel: 1, createMapping: 1 });
});

test("is idempotent when the exact provider mapping already exists", async () => {
  const h = harness({
    channel: channelPayload([
      { id: MAPPING_ID, ratePlanId: RATE_PLAN_ID, listingId: LISTING_ID },
    ]),
  });
  const result = await execute(h);
  assert.deepEqual(result, {
    outcome: "ALREADY_MAPPED",
    listingId: LISTING_ID,
    mappingId: MAPPING_ID,
  });
  assert.equal(h.calls.createMapping, 0);
});

test("blocks incompatible existing mappings before provider mutation", async () => {
  for (const mappings of [
    [{ id: MAPPING_ID, ratePlanId: RATE_PLAN_ID, listingId: "999999999" }],
    [
      {
        id: MAPPING_ID,
        ratePlanId: "22222222-2222-4222-8222-222222222222",
        listingId: LISTING_ID,
      },
    ],
  ]) {
    const h = harness({ channel: channelPayload(mappings) });
    await assert.rejects(
      execute(h),
      (error: unknown) =>
        error instanceof AirbnbHostConfirmedMappingError &&
        error.code === "OTA_AIRBNB_MAPPING_CONFLICT"
    );
    assert.equal(h.calls.createMapping, 0);
  }
});

test("blocks stale or conflicting discovery evidence before reading provider channel state", async () => {
  for (const badDiscovery of [
    discovery({ match: { candidateListingId: "999999999" } }),
    discovery({ match: { reasons: ["LISTING_CONFLICT"] } }),
    discovery({ match: { status: "UNMATCHED", candidateListingId: null } }),
  ]) {
    const h = harness({ discovery: badDiscovery });
    await assert.rejects(
      execute(h),
      (error: unknown) =>
        error instanceof AirbnbHostConfirmedMappingError &&
        error.code === "OTA_AIRBNB_MAPPING_CONFIRMATION_MISMATCH"
    );
    assert.equal(h.calls.getChannel, 0);
    assert.equal(h.calls.createMapping, 0);
  }
});

test("blocks ineligible local context and active provider channels", async () => {
  const wrongTenant = localContext({
    connection: { organizationId: "org-other" },
  });
  const localHarness = harness({ local: wrongTenant });
  await assert.rejects(
    execute(localHarness),
    (error: unknown) =>
      error instanceof AirbnbHostConfirmedMappingError &&
      error.code === "OTA_AIRBNB_MAPPING_CONTEXT_NOT_ELIGIBLE"
  );
  assert.deepEqual(localHarness.calls, { discover: 0, getChannel: 0, createMapping: 0 });

  const activeHarness = harness({ channel: channelPayload([], true) });
  await assert.rejects(
    execute(activeHarness),
    (error: unknown) =>
      error instanceof AirbnbHostConfirmedMappingError &&
      error.code === "OTA_AIRBNB_MAPPING_CHANNEL_STATE_INVALID"
  );
  assert.equal(activeHarness.calls.createMapping, 0);
});

test("rejects a malformed mapping success response instead of advancing lifecycle", async () => {
  const h = harness();
  h.dependencies.mappingTransport.createMapping = async () => {
    h.calls.createMapping += 1;
    return { data: { type: "channel_rate_plan", id: CHANNEL_ID } };
  };
  await assert.rejects(
    execute(h),
    (error: unknown) =>
      error instanceof AirbnbHostConfirmedMappingError &&
      error.code === "OTA_AIRBNB_MAPPING_RESPONSE_INVALID"
  );
  assert.equal(h.calls.createMapping, 1);
});
