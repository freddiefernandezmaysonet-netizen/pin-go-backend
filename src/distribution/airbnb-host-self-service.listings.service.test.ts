import assert from "node:assert/strict";
import test from "node:test";

import { AirbnbHostSelfServiceError } from "./airbnb-host-self-service.service.js";
import {
  discoverAirbnbListings,
  parseAirbnbListingDiscoveryPayload,
} from "./airbnb-host-self-service.listings.service.js";

const CHANNEL_ID = "44444444-4444-4444-8444-444444444444";

const DOCUMENTED_LISTINGS_PAYLOAD = {
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

const DEFAULT_CONNECTION = {
  organizationId: "org-1",
  propertyId: "property-1",
  provider: "AIRBNB",
  externalConnectionId: CHANNEL_ID,
};

const DEFAULT_PROPERTIES = [
  {
    id: "property-1",
    name: "Test Property",
    publicTitle: null,
    city: "text",
    country: "DE",
    maxGuests: 4,
  },
];

function client(args: {
  connection?: any;
  properties?: any[];
} = {}) {
  const connectionQueries: unknown[] = [];
  const propertyQueries: unknown[] = [];
  const connection = Object.prototype.hasOwnProperty.call(args, "connection")
    ? args.connection
    : DEFAULT_CONNECTION;
  const properties = args.properties ?? DEFAULT_PROPERTIES;
  return {
    connectionQueries,
    propertyQueries,
    value: {
      otaChannelConnection: {
        async findFirst(query: unknown) {
          connectionQueries.push(query);
          return connection;
        },
      },
      property: {
        async findMany(query: unknown) {
          propertyQueries.push(query);
          return properties;
        },
      },
    },
  };
}

test("parses the documented Airbnb listing dictionary without adding fields", () => {
  assert.deepEqual(parseAirbnbListingDiscoveryPayload(DOCUMENTED_LISTINGS_PAYLOAD), [
    {
      id: "42544559",
      title: "Test Property · Test Channex Property",
      type: "apartment",
      occupancies: [1, 2, 3, 4],
      synchronizationCategory: "text",
      city: "text",
      countryCode: "DE",
      qualityStatus: "text",
    },
  ]);
});

test("preserves undocumented nullability instead of fabricating metadata", () => {
  assert.deepEqual(
    parseAirbnbListingDiscoveryPayload({
      data: {
        listing_id_dictionary: {
          values: [{ id: "42544559", synchronization_category: null }],
        },
      },
    }),
    [
      {
        id: "42544559",
        title: null,
        type: null,
        occupancies: null,
        synchronizationCategory: null,
        city: null,
        countryCode: null,
        qualityStatus: null,
      },
    ]
  );
});

test("discovers once from the exact persisted Airbnb channel and matches tenant properties locally", async () => {
  const db = client();
  const providerCalls: string[] = [];
  const result = await discoverAirbnbListings({
    client: db.value,
    transport: {
      async listAirbnbListings(channelId) {
        providerCalls.push(channelId);
        return DOCUMENTED_LISTINGS_PAYLOAD;
      },
    },
    organizationId: "org-1",
    propertyId: "property-1",
  });

  assert.deepEqual(db.connectionQueries, [
    {
      where: {
        organizationId: "org-1",
        propertyId: "property-1",
        provider: "AIRBNB",
      },
      select: {
        organizationId: true,
        propertyId: true,
        provider: true,
        externalConnectionId: true,
      },
    },
  ]);
  assert.deepEqual(db.propertyQueries, [
    {
      where: {
        organizationId: "org-1",
        status: "ACTIVE",
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        name: true,
        publicTitle: true,
        city: true,
        country: true,
        maxGuests: true,
      },
    },
  ]);
  assert.deepEqual(providerCalls, [CHANNEL_ID]);
  assert.equal(result.channelId, CHANNEL_ID);
  assert.equal(result.listings[0]?.id, "42544559");
  assert.equal(result.match.propertyId, "property-1");
  assert.equal(result.match.status, "AUTO_MATCH");
  assert.equal(result.match.candidateListingId, "42544559");
  assert.deepEqual(result.portfolioSummary, {
    propertiesConsidered: 1,
    listingsConsidered: 1,
    autoMatched: 1,
    reviewRequired: 0,
    unmatched: 0,
  });
});

test("portfolio matching uses all active properties without extra provider reads", async () => {
  const db = client({
    properties: [
      ...DEFAULT_PROPERTIES,
      {
        id: "property-2",
        name: "Ocean View",
        publicTitle: null,
        city: "San Juan",
        country: "Puerto Rico",
        maxGuests: 6,
      },
    ],
  });
  let providerCalls = 0;
  const result = await discoverAirbnbListings({
    client: db.value,
    transport: {
      async listAirbnbListings() {
        providerCalls += 1;
        return DOCUMENTED_LISTINGS_PAYLOAD;
      },
    },
    organizationId: "org-1",
    propertyId: "property-1",
  });

  assert.equal(providerCalls, 1);
  assert.equal(result.portfolioSummary.propertiesConsidered, 2);
  assert.equal(result.portfolioSummary.listingsConsidered, 1);
});

test("fails closed before provider access when local connection scope does not match", async () => {
  for (const connection of [
    null,
    {
      organizationId: "org-other",
      propertyId: "property-1",
      provider: "AIRBNB",
      externalConnectionId: CHANNEL_ID,
    },
    {
      organizationId: "org-1",
      propertyId: "property-other",
      provider: "AIRBNB",
      externalConnectionId: CHANNEL_ID,
    },
    {
      organizationId: "org-1",
      propertyId: "property-1",
      provider: "BOOKING_COM",
      externalConnectionId: CHANNEL_ID,
    },
    {
      organizationId: "org-1",
      propertyId: "property-1",
      provider: "AIRBNB",
      externalConnectionId: null,
    },
  ]) {
    let providerCalls = 0;
    await assert.rejects(
      discoverAirbnbListings({
        client: client({ connection }).value,
        transport: {
          async listAirbnbListings() {
            providerCalls += 1;
            return DOCUMENTED_LISTINGS_PAYLOAD;
          },
        },
        organizationId: "org-1",
        propertyId: "property-1",
      }),
      (error: unknown) => error instanceof AirbnbHostSelfServiceError
    );
    assert.equal(providerCalls, 0);
  }
});

test("fails closed before provider access when the requested Pin&Go property is not active in tenant scope", async () => {
  let providerCalls = 0;
  await assert.rejects(
    discoverAirbnbListings({
      client: client({
        properties: [
          {
            id: "property-other",
            name: "Other",
            publicTitle: null,
            city: null,
            country: null,
            maxGuests: null,
          },
        ],
      }).value,
      transport: {
        async listAirbnbListings() {
          providerCalls += 1;
          return DOCUMENTED_LISTINGS_PAYLOAD;
        },
      },
      organizationId: "org-1",
      propertyId: "property-1",
    }),
    (error: unknown) =>
      error instanceof AirbnbHostSelfServiceError &&
      error.code === "OTA_AIRBNB_PROPERTY_NOT_FOUND"
  );
  assert.equal(providerCalls, 0);
});

test("rejects malformed listing envelopes without inventing listings", () => {
  for (const payload of [
    null,
    {},
    { data: null },
    { data: {} },
    { data: { listing_id_dictionary: null } },
    { data: { listing_id_dictionary: {} } },
    { data: { listing_id_dictionary: { values: [null] } } },
    { data: { listing_id_dictionary: { values: [{ title: "Missing id" }] } } },
    { data: { listing_id_dictionary: { values: [{ id: "1", occupancies: [1, "2"] }] } } },
  ]) {
    assert.throws(
      () => parseAirbnbListingDiscoveryPayload(payload),
      (error: unknown) =>
        error instanceof AirbnbHostSelfServiceError &&
        error.code === "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
    );
  }
});
