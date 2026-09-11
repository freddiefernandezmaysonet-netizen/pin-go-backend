import assert from "node:assert/strict";
import test from "node:test";

import { AirbnbHostSelfServiceError } from "./airbnb-host-self-service.service.js";
import {
  discoverAirbnbListings,
  parseAirbnbListingDetailsPayload,
  parseAirbnbListingDiscoveryPayload,
} from "./airbnb-host-self-service.listings.service.js";

const CHANNEL_ID = "44444444-4444-4444-8444-444444444444";
const LISTING_ID = "42544559";

const DOCUMENTED_LISTINGS_PAYLOAD = {
  data: {
    listing_id_dictionary: {
      values: [
        {
          id: LISTING_ID,
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
      id_str: LISTING_ID,
      person_capacity: 4,
      city: "Berlin",
      state: "Berlin",
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
    region: "Berlin",
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

function transport(args: {
  listings?: unknown;
  details?: unknown;
  listingCalls?: string[];
  detailCalls?: Array<[string, string]>;
} = {}) {
  return {
    async listAirbnbListings(channelId: string) {
      args.listingCalls?.push(channelId);
      return args.listings ?? DOCUMENTED_LISTINGS_PAYLOAD;
    },
    async getAirbnbListingDetails(channelId: string, listingId: string) {
      args.detailCalls?.push([channelId, listingId]);
      return args.details ?? DOCUMENTED_DETAILS_PAYLOAD;
    },
  };
}

test("parses the documented Airbnb listing dictionary without adding provider fields", () => {
  assert.deepEqual(parseAirbnbListingDiscoveryPayload(DOCUMENTED_LISTINGS_PAYLOAD), [
    {
      id: LISTING_ID,
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

test("parses documented listing_details location and exact person capacity", () => {
  assert.deepEqual(parseAirbnbListingDetailsPayload(DOCUMENTED_DETAILS_PAYLOAD), {
    listingId: LISTING_ID,
    personCapacity: 4,
    city: "Berlin",
    state: "Berlin",
    postalCode: "10115",
    countryCode: "DE",
    latitude: 52.520008,
    longitude: 13.404954,
  });
});

test("discovers once from the persisted Airbnb channel and matches tenant properties locally", async () => {
  const db = client();
  const listingCalls: string[] = [];
  const detailCalls: Array<[string, string]> = [];
  const result = await discoverAirbnbListings({
    client: db.value,
    transport: transport({ listingCalls, detailCalls }),
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
        region: true,
        country: true,
        postalCode: true,
        maxGuests: true,
      },
    },
  ]);
  assert.deepEqual(listingCalls, [CHANNEL_ID]);
  assert.deepEqual(detailCalls, []);
  assert.equal(result.channelId, CHANNEL_ID);
  assert.equal(result.listings[0]?.id, LISTING_ID);
  assert.equal(result.match.status, "AUTO_MATCH");
});

test("Casa Collores production-shaped US plus PR region matches Airbnb PR and corroborates locality", async () => {
  const listingCalls: string[] = [];
  const detailCalls: Array<[string, string]> = [];
  const listings = {
    data: {
      listing_id_dictionary: {
        values: [
          {
            id: "551126434553599406",
            title: "Casa Collores",
            occupancies: [1, 2, 3, 4],
            city: "Collores",
            country_code: "PR",
          },
        ],
      },
    },
  };
  const details = {
    data: {
      listing: {
        id: 551126434553599406,
        id_str: "551126434553599406",
        person_capacity: 3,
        city: "Collores",
        state: "Puerto Rico",
        zipcode: "00771",
        country_code: "PR",
        lat: 18.19,
        lng: -65.87,
      },
    },
  };
  const db = client({
    properties: [
      {
        id: "property-1",
        name: "Casa Collores",
        publicTitle: null,
        city: "Las Piedras",
        region: "PR",
        country: "United States",
        postalCode: "00771",
        maxGuests: 3,
      },
    ],
  });

  const result = await discoverAirbnbListings({
    client: db.value,
    transport: transport({ listings, details, listingCalls, detailCalls }),
    organizationId: "org-1",
    propertyId: "property-1",
  });

  assert.deepEqual(listingCalls, [CHANNEL_ID]);
  assert.deepEqual(detailCalls, [[CHANNEL_ID, "551126434553599406"]]);
  assert.equal(result.match.status, "AUTO_MATCH");
  assert.equal(result.match.reasons.includes("COUNTRY_MISMATCH"), false);
  assert.ok(result.match.reasons.includes("COUNTRY_MATCH"));
  assert.ok(result.match.reasons.includes("POSTAL_CODE_MATCH"));
  assert.ok(result.match.reasons.includes("PERSON_CAPACITY_MATCH"));
});

test("US properties outside Puerto Rico are never treated as PR listings", async () => {
  const listings = {
    data: {
      listing_id_dictionary: {
        values: [
          {
            id: LISTING_ID,
            title: "Test Property · Test Channex Property",
            city: "text",
            country_code: "PR",
          },
        ],
      },
    },
  };
  const result = await discoverAirbnbListings({
    client: client({
      properties: [
        {
          ...DEFAULT_PROPERTIES[0],
          region: "FL",
          country: "United States",
        },
      ],
    }).value,
    transport: transport({ listings }),
    organizationId: "org-1",
    propertyId: "property-1",
  });

  assert.equal(result.match.status, "REVIEW_REQUIRED");
  assert.ok(result.match.reasons.includes("COUNTRY_MISMATCH"));
});

test("detail corroboration failure remains review required and retains a bounded failure class", async () => {
  const listings = {
    data: {
      listing_id_dictionary: {
        values: [
          {
            id: LISTING_ID,
            title: "Test Property · Test Channex Property",
            city: "Other locality",
            country_code: "DE",
          },
        ],
      },
    },
  };
  const scenarios = [
    ["OTA_AIRBNB_LISTING_DISCOVERY_NOT_FOUND", "DETAILS_NOT_FOUND"],
    ["OTA_AIRBNB_LISTING_DISCOVERY_RATE_LIMITED", "DETAILS_RATE_LIMITED"],
    ["OTA_AIRBNB_LISTING_DISCOVERY_REQUEST_REJECTED", "DETAILS_REQUEST_REJECTED"],
    ["OTA_AIRBNB_LISTING_DISCOVERY_PROVIDER_UNAVAILABLE", "DETAILS_PROVIDER_UNAVAILABLE"],
    ["OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_TOO_LARGE", "DETAILS_RESPONSE_TOO_LARGE"],
    ["OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID", "DETAILS_RESPONSE_INVALID"],
  ] as const;

  for (const [code, expectedReason] of scenarios) {
    const result = await discoverAirbnbListings({
      client: client().value,
      transport: {
        async listAirbnbListings() {
          return listings;
        },
        async getAirbnbListingDetails() {
          throw Object.assign(new Error("safe classified failure"), { code });
        },
      },
      organizationId: "org-1",
      propertyId: "property-1",
    });

    assert.equal(result.match.status, "REVIEW_REQUIRED");
    assert.ok(result.match.reasons.includes("DETAILS_UNAVAILABLE"));
    assert.ok(result.match.reasons.includes(expectedReason));
  }
});

test("unknown detail errors remain generic and do not leak error text", async () => {
  const listings = {
    data: {
      listing_id_dictionary: {
        values: [
          {
            id: LISTING_ID,
            title: "Test Property · Test Channex Property",
            city: "Other locality",
            country_code: "DE",
          },
        ],
      },
    },
  };
  const result = await discoverAirbnbListings({
    client: client().value,
    transport: {
      async listAirbnbListings() {
        return listings;
      },
      async getAirbnbListingDetails() {
        throw new Error("secret-provider-body-must-never-appear");
      },
    },
    organizationId: "org-1",
    propertyId: "property-1",
  });

  assert.equal(result.match.status, "REVIEW_REQUIRED");
  assert.deepEqual(
    result.match.reasons.filter((reason) => reason.startsWith("DETAILS_")),
    ["DETAILS_UNAVAILABLE"]
  );
  assert.equal(result.match.reasons.join(" ").includes("secret-provider-body"), false);
});

test("portfolio conflict detection prevents extra provider detail reads", async () => {
  const db = client({
    properties: [
      { ...DEFAULT_PROPERTIES[0], city: "other" },
      { ...DEFAULT_PROPERTIES[0], id: "property-2", city: "other" },
    ],
  });
  const detailCalls: Array<[string, string]> = [];
  const result = await discoverAirbnbListings({
    client: db.value,
    transport: transport({ detailCalls }),
    organizationId: "org-1",
    propertyId: "property-1",
  });

  assert.equal(result.match.status, "REVIEW_REQUIRED");
  assert.ok(result.match.reasons.includes("LISTING_CONFLICT"));
  assert.deepEqual(detailCalls, []);
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
            region: null,
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

test("rejects malformed listing envelopes and details without inventing fields", () => {
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

  for (const payload of [
    null,
    {},
    { data: {} },
    { data: { listing: null } },
    { data: { listing: { id: 1 } } },
    { data: { listing: { id_str: "1", person_capacity: "2" } } },
  ]) {
    assert.throws(
      () => parseAirbnbListingDetailsPayload(payload),
      (error: unknown) =>
        error instanceof AirbnbHostSelfServiceError &&
        error.code === "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
    );
  }
});