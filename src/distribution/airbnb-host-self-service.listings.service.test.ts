import assert from "node:assert/strict";
import test from "node:test";

import { AirbnbHostSelfServiceError } from "./airbnb-host-self-service.service.js";
import {
  discoverAirbnbListings,
  parseAirbnbListingDetailsPayload,
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

const DOCUMENTED_DETAILS_PAYLOAD = {
  data: {
    listing: {
      id: 42544559,
      id_str: "42544559",
      name: "Test Property · Test Channex Property",
      person_capacity: 4,
      city: "Berlin",
      state: "Berlin",
      street: "Musterstraße 12",
      zipcode: "10115",
      country_code: "DE",
      lat: 52.520008,
      lng: 13.404954,
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
    name: "Test Property · Test Channex Property",
    publicTitle: null,
    city: "text",
    country: "DE",
    postalCode: "10115",
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

test("parses the documented Airbnb listing dictionary without inventing provider fields", () => {
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

test("parses only documented listing-details evidence", () => {
  assert.deepEqual(parseAirbnbListingDetailsPayload(DOCUMENTED_DETAILS_PAYLOAD), {
    id: "42544559",
    name: "Test Property · Test Channex Property",
    personCapacity: 4,
    city: "Berlin",
    state: "Berlin",
    street: "Musterstraße 12",
    postalCode: "10115",
    countryCode: "DE",
    latitude: 52.520008,
    longitude: 13.404954,
  });
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

test("discovers once from the persisted Airbnb channel and does not fetch details for an already-high-confidence match", async () => {
  const db = client();
  const listingCalls: string[] = [];
  let detailsCalls = 0;
  const result = await discoverAirbnbListings({
    client: db.value,
    transport: {
      async listAirbnbListings(channelId) {
        listingCalls.push(channelId);
        return DOCUMENTED_LISTINGS_PAYLOAD;
      },
      async getAirbnbListingDetails() {
        detailsCalls += 1;
        return DOCUMENTED_DETAILS_PAYLOAD;
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
        postalCode: true,
        maxGuests: true,
      },
    },
  ]);
  assert.deepEqual(listingCalls, [CHANNEL_ID]);
  assert.equal(detailsCalls, 0);
  assert.equal(result.channelId, CHANNEL_ID);
  assert.equal(result.listings[0]?.id, "42544559");
  assert.equal(result.match.propertyId, "property-1");
  assert.equal(result.match.status, "AUTO_MATCH");
  assert.equal(result.match.candidateListingId, "42544559");
});

test("uses one candidate-specific details GET to corroborate Las Piedras versus Collores", async () => {
  const db = client({
    properties: [
      {
        id: "property-1",
        name: "Casa Collores",
        publicTitle: null,
        city: "Las Piedras",
        country: "Puerto Rico",
        postalCode: "00771",
        maxGuests: 2,
      },
    ],
  });
  const listingCalls: string[] = [];
  const detailCalls: Array<{ channelId: string; listingId: string }> = [];

  const result = await discoverAirbnbListings({
    client: db.value,
    transport: {
      async listAirbnbListings(channelId) {
        listingCalls.push(channelId);
        return {
          data: {
            listing_id_dictionary: {
              values: [
                {
                  id: "551126434553599406",
                  title: "Casa Collores",
                  occupancies: [1, 2],
                  city: "Collores",
                  country_code: "PR",
                },
              ],
            },
          },
        };
      },
      async getAirbnbListingDetails(channelId, listingId) {
        detailCalls.push({ channelId, listingId });
        return {
          data: {
            listing: {
              id_str: listingId,
              name: "Casa Collores",
              person_capacity: 2,
              city: "Collores",
              state: "Puerto Rico",
              street: "Development address",
              zipcode: "00771",
              country_code: "PR",
              lat: 18.0,
              lng: -66.0,
            },
          },
        };
      },
    },
    organizationId: "org-1",
    propertyId: "property-1",
  });

  assert.deepEqual(listingCalls, [CHANNEL_ID]);
  assert.deepEqual(detailCalls, [
    { channelId: CHANNEL_ID, listingId: "551126434553599406" },
  ]);
  assert.equal(result.match.status, "AUTO_MATCH");
  assert.equal(result.match.confidence, "HIGH");
  assert.ok(result.match.reasons.includes("POSTAL_CODE_MATCH"));
  assert.ok(result.match.reasons.includes("PERSON_CAPACITY_MATCH"));
});

test("details fallback fails closed to review instead of failing listing discovery", async () => {
  const db = client({
    properties: [
      {
        id: "property-1",
        name: "Casa Collores",
        publicTitle: null,
        city: "Las Piedras",
        country: "Puerto Rico",
        postalCode: "00771",
        maxGuests: 2,
      },
    ],
  });
  let listingCalls = 0;
  let detailsCalls = 0;

  const result = await discoverAirbnbListings({
    client: db.value,
    transport: {
      async listAirbnbListings() {
        listingCalls += 1;
        return {
          data: {
            listing_id_dictionary: {
              values: [
                {
                  id: "candidate-1",
                  title: "Casa Collores",
                  city: "Collores",
                  country_code: "PR",
                },
              ],
            },
          },
        };
      },
      async getAirbnbListingDetails() {
        detailsCalls += 1;
        throw new Error("provider unavailable");
      },
    },
    organizationId: "org-1",
    propertyId: "property-1",
  });

  assert.equal(listingCalls, 1);
  assert.equal(detailsCalls, 1);
  assert.equal(result.match.status, "REVIEW_REQUIRED");
  assert.ok(result.match.reasons.includes("DETAILS_UNAVAILABLE"));
});

test("portfolio conflict detection uses active tenant properties without extra details reads", async () => {
  const db = client({
    properties: [
      DEFAULT_PROPERTIES[0],
      {
        ...DEFAULT_PROPERTIES[0],
        id: "property-2",
      },
    ],
  });
  let listingCalls = 0;
  let detailsCalls = 0;
  const result = await discoverAirbnbListings({
    client: db.value,
    transport: {
      async listAirbnbListings() {
        listingCalls += 1;
        return DOCUMENTED_LISTINGS_PAYLOAD;
      },
      async getAirbnbListingDetails() {
        detailsCalls += 1;
        return DOCUMENTED_DETAILS_PAYLOAD;
      },
    },
    organizationId: "org-1",
    propertyId: "property-1",
  });

  assert.equal(listingCalls, 1);
  assert.equal(detailsCalls, 0);
  assert.equal(result.match.status, "REVIEW_REQUIRED");
  assert.ok(result.match.reasons.includes("LISTING_CONFLICT"));
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
          async getAirbnbListingDetails() {
            providerCalls += 1;
            return DOCUMENTED_DETAILS_PAYLOAD;
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

test("fails closed before provider access when the requested Pin&Go property is not active", async () => {
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
            postalCode: null,
            maxGuests: null,
          },
        ],
      }).value,
      transport: {
        async listAirbnbListings() {
          providerCalls += 1;
          return DOCUMENTED_LISTINGS_PAYLOAD;
        },
        async getAirbnbListingDetails() {
          providerCalls += 1;
          return DOCUMENTED_DETAILS_PAYLOAD;
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

test("rejects malformed listing-details envelopes", () => {
  for (const payload of [
    null,
    {},
    { data: null },
    { data: {} },
    { data: { listing: null } },
    { data: { listing: { name: "Missing id" } } },
    { data: { listing: { id_str: "1", person_capacity: "2" } } },
    { data: { listing: { id_str: "1", lat: "18.0" } } },
  ]) {
    assert.throws(
      () => parseAirbnbListingDetailsPayload(payload),
      (error: unknown) =>
        error instanceof AirbnbHostSelfServiceError &&
        error.code === "OTA_AIRBNB_LISTING_DETAILS_RESPONSE_INVALID"
    );
  }
});
