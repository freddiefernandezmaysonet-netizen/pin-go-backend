import assert from "node:assert/strict";
import test from "node:test";

import {
  AirbnbHostListingsError,
  discoverAirbnbHostListings,
} from "./airbnb-host-self-service.listings.service.js";
import {
  AirbnbListingsHttpTransportError,
  createAirbnbHostSelfServiceListingsHttpTransport,
} from "./airbnb-host-self-service.listings.http-transport.js";

const CHANNEL_ID = "716305c4-561a-4561-a187-7f5b8aeb5920";
const PROPERTY_ID = "daec1c06-a9f6-4a25-88fa-cc4e9dbea436";
const GROUP_ID = "5b79c003-a0b0-45b5-8428-e006a26b6a82";

// Literal GET /channels/{id} example retained exactly where Gate 3 needs it.
const DOCUMENTED_CHANNEL = {
  data: {
    type: "channel",
    id: CHANNEL_ID,
    attributes: {
      id: "96177287-c3b2-4d98-9eb7-5c1927795825",
      channel: "BookingCom",
      is_active: true,
      properties: [PROPERTY_ID],
    },
    relationships: {
      group: { data: { id: GROUP_ID, type: "group" } },
      properties: { data: [{ id: PROPERTY_ID, type: "property" }] },
    },
  },
};

// Literal 200 listing dictionary from the supplied Channex Airbnb guide.
const DOCUMENTED_LISTINGS = {
  data: {
    listing_id_dictionary: {
      values: [
        {
          id: "42544559",
          title: "Test Property · Test Channex Property",
          type: "apartment",
          occupancies: [1, 2, 3, 4],
          synchronization_category: "text",
          city: "text",
          country_code: "DE",
          quality_status: "text",
        },
      ],
    },
  },
};

function client() {
  return {
    distributionProperty: {
      async findFirst() {
        return {
          organizationId: "org-1",
          propertyId: "property-1",
          platform: "CHANNEX",
          provisioningStatus: "READY",
          externalPropertyId: PROPERTY_ID,
          externalPrimaryRoomTypeId: null,
          externalPrimaryRatePlanId: null,
          group: {
            organizationId: "org-1",
            platform: "CHANNEX",
            provisioningStatus: "READY",
            externalGroupId: GROUP_ID,
          },
        };
      },
    },
  };
}

test("literal Airbnb listing response verifies provider-specific phase and stops at mapping required", async () => {
  const calls: string[] = [];
  const result = await discoverAirbnbHostListings({
    client: client(),
    transport: {
      async getChannel(id) {
        calls.push(`channel:${id}`);
        return structuredClone(DOCUMENTED_CHANNEL);
      },
      async listListings(id) {
        calls.push(`listings:${id}`);
        return structuredClone(DOCUMENTED_LISTINGS);
      },
    },
    organizationId: "org-1",
    propertyId: "property-1",
    channelId: CHANNEL_ID,
  });

  assert.deepEqual(calls, [`channel:${CHANNEL_ID}`, `listings:${CHANNEL_ID}`]);
  assert.deepEqual(result, {
    propertyId: "property-1",
    channelId: CHANNEL_ID,
    airbnbAccountVerified: true,
    listings: [{ id: "42544559", title: "Test Property · Test Channex Property" }],
    nextAction: "MAPPING_REQUIRED",
  });
});

test("empty documented dictionary shape is accepted without inventing a minimum listing count", async () => {
  const result = await discoverAirbnbHostListings({
    client: client(),
    transport: {
      async getChannel() { return structuredClone(DOCUMENTED_CHANNEL); },
      async listListings() { return { data: { listing_id_dictionary: { values: [] } } }; },
    },
    organizationId: "org-1",
    propertyId: "property-1",
    channelId: CHANNEL_ID,
  });
  assert.deepEqual(result.listings, []);
  assert.equal(result.airbnbAccountVerified, true);
  assert.equal(result.nextAction, "MAPPING_REQUIRED");
});

test("listing parser requires only documented mapping identity fields and preserves them exactly", async () => {
  const payload = structuredClone(DOCUMENTED_LISTINGS);
  payload.data.listing_id_dictionary.values = [
    { ...payload.data.listing_id_dictionary.values[0]!, id: "001-raw-id", title: "  Exact title  " },
    { ...payload.data.listing_id_dictionary.values[0]!, id: "001-raw-id", title: "Duplicate id is not locally forbidden" },
  ];
  const result = await discoverAirbnbHostListings({
    client: client(),
    transport: {
      async getChannel() { return structuredClone(DOCUMENTED_CHANNEL); },
      async listListings() { return payload; },
    },
    organizationId: "org-1",
    propertyId: "property-1",
    channelId: CHANNEL_ID,
  });
  assert.deepEqual(result.listings, [
    { id: "001-raw-id", title: "  Exact title  " },
    { id: "001-raw-id", title: "Duplicate id is not locally forbidden" },
  ]);
});

for (const [label, payload] of [
  ["missing data", {}],
  ["missing dictionary", { data: {} }],
  ["missing values", { data: { listing_id_dictionary: {} } }],
  ["missing id", { data: { listing_id_dictionary: { values: [{ title: "x" }] } } }],
  ["missing title", { data: { listing_id_dictionary: { values: [{ id: "1" }] } } }],
] as Array<[string, unknown]>) {
  test(`malformed listing response fails closed: ${label}`, async () => {
    await assert.rejects(
      () => discoverAirbnbHostListings({
        client: client(),
        transport: {
          async getChannel() { return structuredClone(DOCUMENTED_CHANNEL); },
          async listListings() { return payload; },
        },
        organizationId: "org-1",
        propertyId: "property-1",
        channelId: CHANNEL_ID,
      }),
      (error: unknown) =>
        error instanceof AirbnbHostListingsError &&
        error.code === "OTA_AIRBNB_LISTINGS_RESPONSE_INVALID"
    );
  });
}

test("property boundary failure prevents listings request", async () => {
  let listingCalls = 0;
  const wrong = structuredClone(DOCUMENTED_CHANNEL);
  wrong.data.attributes.properties = ["11111111-1111-4111-8111-111111111111"];
  await assert.rejects(() => discoverAirbnbHostListings({
    client: client(),
    transport: {
      async getChannel() { return wrong; },
      async listListings() { listingCalls += 1; return DOCUMENTED_LISTINGS; },
    },
    organizationId: "org-1",
    propertyId: "property-1",
    channelId: CHANNEL_ID,
  }));
  assert.equal(listingCalls, 0);
});

test("dedicated transport emits exactly one documented GET with user-api-key", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const transport = createAirbnbHostSelfServiceListingsHttpTransport({
    apiOrigin: "https://staging.channex.io",
    apiKey: "test-api-key",
    timeoutMs: 5_000,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(DOCUMENTED_LISTINGS), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(await transport.listListings(CHANNEL_ID), DOCUMENTED_LISTINGS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `https://staging.channex.io/api/v1/channels/${CHANNEL_ID}/action/listings`);
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal((calls[0]!.init?.headers as Record<string, string>)["user-api-key"], "test-api-key");
  assert.equal(calls[0]!.init?.body, undefined);
  assert.equal(calls[0]!.init?.redirect, "error");
});

for (const status of [400, 422, 503]) {
  test(`dedicated transport does not retry documented failure status ${status}`, async () => {
    let calls = 0;
    const transport = createAirbnbHostSelfServiceListingsHttpTransport({
      apiOrigin: "https://app.channex.io",
      apiKey: "test-api-key",
      timeoutMs: 5_000,
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", { status });
      },
    });
    await assert.rejects(() => transport.listListings(CHANNEL_ID),
      (error: unknown) => error instanceof AirbnbListingsHttpTransportError);
    assert.equal(calls, 1);
  });
}

test("invalid channel id is rejected before network", async () => {
  let calls = 0;
  const transport = createAirbnbHostSelfServiceListingsHttpTransport({
    apiOrigin: "https://app.channex.io",
    apiKey: "test-api-key",
    timeoutMs: 5_000,
    fetchImpl: async () => { calls += 1; return new Response("{}"); },
  });
  await assert.rejects(() => transport.listListings("../mapping"));
  assert.equal(calls, 0);
});
