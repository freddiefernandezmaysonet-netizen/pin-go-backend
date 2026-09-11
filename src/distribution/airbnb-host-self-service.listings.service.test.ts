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

function client(row: any = {
  organizationId: "org-1",
  propertyId: "property-1",
  provider: "AIRBNB",
  externalConnectionId: CHANNEL_ID,
}) {
  const queries: unknown[] = [];
  return {
    queries,
    value: {
      otaChannelConnection: {
        async findFirst(query: unknown) {
          queries.push(query);
          return row;
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

test("discovers listings from the exact persisted Airbnb channel for tenant/property scope", async () => {
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

  assert.deepEqual(db.queries, [
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
  assert.deepEqual(providerCalls, [CHANNEL_ID]);
  assert.equal(result.channelId, CHANNEL_ID);
  assert.equal(result.listings[0].id, "42544559");
});

test("fails closed before provider access when local connection scope does not match", async () => {
  for (const row of [
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
        client: client(row).value,
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
