import assert from "node:assert/strict";
import test from "node:test";

import {
  ChannexChannelIdentityError,
  discoverUniqueChannexChannel,
  verifyExactChannexChannel,
} from "./channex-channel-identity.js";

const PROPERTY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROPERTY_ID = "11111111-1111-4111-8111-111111111112";
const ROOM_TYPE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ROOM_TYPE_ID = "22222222-2222-4222-8222-222222222223";
const RATE_PLAN_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_RATE_PLAN_ID = "33333333-3333-4333-8333-333333333334";
const CHANNEL_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_CHANNEL_ID = "44444444-4444-4444-8444-444444444445";
const MAPPING_ID = "55555555-5555-4555-8555-555555555555";
const OUTBOUND_MAPPING_ID = "66666666-6666-4666-8666-666666666666";
const GROUP_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_GROUP_ID = "77777777-7777-4777-8777-777777777778";

function listChannel(args: {
  id: string;
  channel?: string;
  propertyId?: string;
}) {
  return {
    type: "channel",
    id: args.id,
    attributes: {
      channel: args.channel ?? "Airbnb",
      properties: [args.propertyId ?? PROPERTY_ID],
    },
    relationships: {
      properties: {
        data: [
          { type: "property", id: args.propertyId ?? PROPERTY_ID },
        ],
      },
    },
  };
}

function exactChannel(args: {
  id?: string;
  attributeId?: string;
  channel?: string;
  isActive?: unknown;
  status?: unknown;
  includeStatus?: boolean;
  propertyId?: string;
  attributePropertyIds?: unknown[];
  propertyType?: string;
  groupId?: string;
  groupType?: string;
  ratePlans?: unknown[];
  listingId?: unknown;
  knownMappings?: unknown[];
  type?: string;
} = {}) {
  const id = args.id ?? CHANNEL_ID;
  return {
    data: {
      type: args.type ?? "channel",
      id,
      attributes: {
        id: args.attributeId ?? id,
        channel: args.channel ?? "Airbnb",
        is_active: args.isActive ?? true,
        ...(args.includeStatus ? { status: args.status } : {}),
        properties: args.attributePropertyIds ?? [args.propertyId ?? PROPERTY_ID],
        rate_plans:
          args.ratePlans ??
          [
            {
              id: OUTBOUND_MAPPING_ID,
              rate_plan_id: RATE_PLAN_ID,
              settings: {
                listing_id: args.listingId ?? "airbnb-listing-1",
              },
            },
          ],
      },
      relationships: {
        properties: {
          data: [
            {
              type: args.propertyType ?? "property",
              id: args.propertyId ?? PROPERTY_ID,
            },
          ],
        },
        group: {
          data: {
            type: args.groupType ?? "group",
            id: args.groupId ?? GROUP_ID,
          },
        },
        known_mappings: {
          data:
            args.knownMappings ??
            [
              {
                type: "known_mapping",
                id: MAPPING_ID,
                attributes: {
                  id: MAPPING_ID,
                  type: "auto",
                  room_type_id: ROOM_TYPE_ID,
                  rate_plan_id: RATE_PLAN_ID,
                  room_type_code: "ota-room-1",
                  rate_plan_code: "ota-rate-1",
                },
              },
            ],
        },
      },
    },
  };
}

const expected = {
  provider: "AIRBNB" as const,
  expectedChannelId: CHANNEL_ID,
  expectedPropertyId: PROPERTY_ID,
  expectedGroupId: GROUP_ID,
  expectedRoomTypeId: ROOM_TYPE_ID,
  expectedRatePlanId: RATE_PLAN_ID,
};

test("discovery returns only the unique documented provider + property candidate", () => {
  const result = discoverUniqueChannexChannel({
    payload: {
      data: [
        listChannel({ id: CHANNEL_ID }),
        listChannel({ id: OTHER_CHANNEL_ID, channel: "BookingCom" }),
      ],
      meta: { page: 1, limit: 100, total: 2 },
    },
    provider: "AIRBNB",
    expectedPropertyId: PROPERTY_ID,
  });
  assert.deepEqual(result, {
    outcome: "FOUND",
    channelId: CHANNEL_ID,
    candidateCount: 1,
  });
});

test("discovery rejects legacy provider aliases instead of widening identity", () => {
  const result = discoverUniqueChannexChannel({
    payload: {
      data: [listChannel({ id: CHANNEL_ID, channel: "ABB" })],
      meta: { page: 1, limit: 100, total: 1 },
    },
    provider: "AIRBNB",
    expectedPropertyId: PROPERTY_ID,
  });
  assert.equal(result.outcome, "NOT_FOUND");
});

test("discovery never guesses between multiple exact candidates", () => {
  const result = discoverUniqueChannexChannel({
    payload: {
      data: [
        listChannel({ id: CHANNEL_ID }),
        listChannel({ id: OTHER_CHANNEL_ID }),
      ],
      meta: { page: 1, limit: 100, total: 2 },
    },
    provider: "AIRBNB",
    expectedPropertyId: PROPERTY_ID,
  });
  assert.deepEqual(result, {
    outcome: "AMBIGUOUS",
    channelId: null,
    candidateCount: 2,
  });
});

test("discovery requires UUID resources and typed property relationships", () => {
  for (const resource of [
    listChannel({ id: "not-a-uuid" }),
    listChannel({ id: CHANNEL_ID, propertyId: "not-a-uuid" }),
    {
      ...listChannel({ id: CHANNEL_ID }),
      relationships: {
        properties: { data: [{ type: "group", id: PROPERTY_ID }] },
      },
    },
  ]) {
    assert.throws(
      () =>
        discoverUniqueChannexChannel({
          payload: {
            data: [resource],
            meta: { page: 1, limit: 100, total: 1 },
          },
          provider: "AIRBNB",
          expectedPropertyId: PROPERTY_ID,
        }),
      (error: unknown) =>
        error instanceof ChannexChannelIdentityError &&
        error.code === "OTA_CHANNEL_COLLECTION_RESPONSE_INVALID"
    );
  }
});

test("discovery rejects missing or contradictory attributes.properties evidence", () => {
  const missingAttributesProperties = listChannel({ id: CHANNEL_ID }) as any;
  delete missingAttributesProperties.attributes.properties;
  const contradictoryProperties = listChannel({ id: CHANNEL_ID }) as any;
  contradictoryProperties.attributes.properties = [OTHER_PROPERTY_ID];

  for (const resource of [
    missingAttributesProperties,
    contradictoryProperties,
  ]) {
    assert.throws(
      () =>
        discoverUniqueChannexChannel({
          payload: {
            data: [resource],
            meta: { page: 1, limit: 100, total: 1 },
          },
          provider: "AIRBNB",
          expectedPropertyId: PROPERTY_ID,
        }),
      (error: unknown) =>
        error instanceof ChannexChannelIdentityError &&
        error.code === "OTA_CHANNEL_COLLECTION_RESPONSE_INVALID"
    );
  }
});

test("exact verification proves active Airbnb outbound mapping", () => {
  const result = verifyExactChannexChannel({
    payload: exactChannel(),
    ...expected,
  });
  assert.deepEqual(result, {
    channelId: CHANNEL_ID,
    resourceTypeVerified: true,
    providerVerified: true,
    propertyVerified: true,
    groupVerified: true,
    identityVerified: true,
    activeState: true,
    connectedEvidenceVerified: true,
    knownMappingVerified: true,
    outboundMappingVerified: true,
    airbnbListingVerified: true,
    airbnbListingId: "airbnb-listing-1",
    mappingVerified: true,
    reasons: [],
  });
});

test("data.id and attributes.id are required UUIDs and must agree", () => {
  for (const payload of [
    exactChannel({ id: "not-a-uuid" }),
    exactChannel({ attributeId: OTHER_CHANNEL_ID }),
  ]) {
    assert.throws(
      () => verifyExactChannexChannel({ payload, ...expected }),
      (error: unknown) =>
        error instanceof ChannexChannelIdentityError &&
        error.code === "OTA_CHANNEL_RESOURCE_RESPONSE_INVALID"
    );
  }
});

test("resource type, exact provider and expected property cannot be inferred", () => {
  const wrongType = verifyExactChannexChannel({
    payload: exactChannel({ type: "property" }),
    ...expected,
  });
  assert.equal(wrongType.resourceTypeVerified, false);
  assert.equal(wrongType.identityVerified, false);

  const wrongProvider = verifyExactChannexChannel({
    payload: exactChannel({ channel: "ABB" }),
    ...expected,
  });
  assert.equal(wrongProvider.providerVerified, false);
  assert.equal(wrongProvider.identityVerified, false);

  const wrongProperty = verifyExactChannexChannel({
    payload: exactChannel({ propertyId: OTHER_PROPERTY_ID }),
    ...expected,
  });
  assert.equal(wrongProperty.propertyVerified, false);
  assert.equal(wrongProperty.identityVerified, false);
});

test("property relationship rejects undocumented resource types", () => {
  assert.throws(
    () =>
      verifyExactChannexChannel({
        payload: exactChannel({ propertyType: "group" }),
        ...expected,
      }),
    (error: unknown) =>
      error instanceof ChannexChannelIdentityError &&
      error.code === "OTA_CHANNEL_RESOURCE_RESPONSE_INVALID"
  );
});

test("exact verification rejects contradictory property sources", () => {
  assert.throws(
    () =>
      verifyExactChannexChannel({
        payload: exactChannel({
          propertyId: PROPERTY_ID,
          attributePropertyIds: [OTHER_PROPERTY_ID],
        }),
        ...expected,
      }),
    (error: unknown) =>
      error instanceof ChannexChannelIdentityError &&
      error.code === "OTA_CHANNEL_RESOURCE_RESPONSE_INVALID"
  );
});

test("exact verification requires a typed UUID group relationship", () => {
  for (const payload of [
    exactChannel({ groupType: "property" }),
    exactChannel({ groupId: "not-a-uuid" }),
  ]) {
    assert.throws(
      () => verifyExactChannexChannel({ payload, ...expected }),
      (error: unknown) =>
        error instanceof ChannexChannelIdentityError &&
        error.code === "OTA_CHANNEL_RESOURCE_RESPONSE_INVALID"
    );
  }
});

test("exact verification requires equality with the expected group", () => {
  const result = verifyExactChannexChannel({
    payload: exactChannel({ groupId: OTHER_GROUP_ID }),
    ...expected,
  });
  assert.equal(result.groupVerified, false);
  assert.equal(result.identityVerified, false);
  assert.ok(result.reasons.includes("CHANNEL_GROUP_NOT_VERIFIED"));
});

test("is_active must be a literal boolean and only true is connected evidence", () => {
  const unknown = verifyExactChannexChannel({
    payload: exactChannel({ isActive: "true" }),
    ...expected,
  });
  assert.equal(unknown.activeState, null);
  assert.equal(unknown.connectedEvidenceVerified, false);
  assert.ok(unknown.reasons.includes("CHANNEL_ACTIVE_STATE_NOT_VERIFIED"));

  const inactive = verifyExactChannexChannel({
    payload: exactChannel({ isActive: false }),
    ...expected,
  });
  assert.equal(inactive.activeState, false);
  assert.equal(inactive.connectedEvidenceVerified, false);
  assert.ok(inactive.reasons.includes("NO_CONNECTED_CHANNEL_EVIDENCE"));
});

test("optional channel status blocks connected evidence unless literally active", () => {
  const active = verifyExactChannexChannel({
    payload: exactChannel({ includeStatus: true, status: "active" }),
    ...expected,
  });
  assert.equal(active.connectedEvidenceVerified, true);

  for (const status of [
    "pending",
    "temporal_error",
    "permanent_error",
    "unknown_future_status",
    true,
    null,
  ]) {
    const result = verifyExactChannexChannel({
      payload: exactChannel({ includeStatus: true, status }),
      ...expected,
    });
    assert.equal(result.activeState, true);
    assert.equal(result.connectedEvidenceVerified, false);
    assert.ok(result.reasons.includes("NO_CONNECTED_CHANNEL_EVIDENCE"));
  }
});

test("known_mappings is strict audit evidence but an empty set does not block outbound mapping", () => {
  const result = verifyExactChannexChannel({
    payload: exactChannel({ knownMappings: [] }),
    ...expected,
  });
  assert.equal(result.knownMappingVerified, false);
  assert.equal(result.outboundMappingVerified, true);
  assert.equal(result.mappingVerified, true);
  assert.equal(result.reasons.includes("CHANNEL_MAPPING_NOT_VERIFIED"), false);
});

test("known_mappings accepts only the documented inline shape", () => {
  const invalidMappings = [
    [
      {
        type: "known_mapping",
        id: MAPPING_ID,
        attributes: {
          id: MAPPING_ID,
          type: "remembered",
          room_type_id: ROOM_TYPE_ID,
          rate_plan_id: RATE_PLAN_ID,
          room_type_code: "ota-room",
          rate_plan_code: "ota-rate",
        },
      },
    ],
    [{ type: "known_mapping", id: MAPPING_ID }],
  ];
  for (const knownMappings of invalidMappings) {
    assert.throws(
      () =>
        verifyExactChannexChannel({
          payload: exactChannel({ knownMappings }),
          ...expected,
        }),
      (error: unknown) =>
        error instanceof ChannexChannelIdentityError &&
        error.code === "OTA_CHANNEL_RESOURCE_RESPONSE_INVALID"
    );
  }
});

test("known mapping requires room and rate in the same documented resource", () => {
  const result = verifyExactChannexChannel({
    payload: exactChannel({
      knownMappings: [
        {
          type: "known_mapping",
          id: MAPPING_ID,
          attributes: {
            id: MAPPING_ID,
            type: "manual",
            room_type_id: OTHER_ROOM_TYPE_ID,
            rate_plan_id: RATE_PLAN_ID,
            room_type_code: "ota-room",
            rate_plan_code: "ota-rate",
          },
        },
      ],
    }),
    ...expected,
  });
  assert.equal(result.knownMappingVerified, false);
  assert.equal(result.mappingVerified, true);
});

test("Airbnb mapping requires the exact outbound rate plan and listing id", () => {
  const wrongRate = verifyExactChannexChannel({
    payload: exactChannel({
      ratePlans: [
        {
          id: OUTBOUND_MAPPING_ID,
          rate_plan_id: OTHER_RATE_PLAN_ID,
          settings: { listing_id: "other-listing" },
        },
      ],
    }),
    ...expected,
  });
  assert.equal(wrongRate.outboundMappingVerified, false);
  assert.equal(wrongRate.mappingVerified, false);
  assert.ok(wrongRate.reasons.includes("CHANNEL_OUTBOUND_MAPPING_NOT_VERIFIED"));

  const noListing = verifyExactChannexChannel({
    payload: exactChannel({ listingId: "" }),
    ...expected,
  });
  assert.equal(noListing.airbnbListingVerified, false);
  assert.equal(noListing.outboundMappingVerified, false);
  assert.equal(noListing.mappingVerified, false);
  assert.ok(noListing.reasons.includes("CHANNEL_AIRBNB_LISTING_NOT_VERIFIED"));
});

test("Airbnb rate plan and listing id must coexist in the same outbound item", () => {
  const payload = exactChannel({
    ratePlans: [
      {
        id: OUTBOUND_MAPPING_ID,
        rate_plan_id: RATE_PLAN_ID,
        settings: { listing_id: "" },
      },
      {
        id: "66666666-6666-4666-8666-666666666667",
        rate_plan_id: OTHER_RATE_PLAN_ID,
        settings: { listing_id: "other-listing" },
      },
    ],
  }) as any;
  payload.data.attributes.settings = { listing_id: "top-level-spoof" };

  const result = verifyExactChannexChannel({ payload, ...expected });
  assert.equal(result.airbnbListingVerified, false);
  assert.equal(result.airbnbListingId, null);
  assert.equal(result.outboundMappingVerified, false);
  assert.equal(result.mappingVerified, false);
});

test("Airbnb supports first binding and then requires the exact stable listing id", () => {
  const firstBinding = verifyExactChannexChannel({
    payload: exactChannel({ listingId: "123456789" }),
    ...expected,
  });
  assert.equal(firstBinding.airbnbListingId, "123456789");
  assert.equal(firstBinding.airbnbListingVerified, true);
  assert.equal(firstBinding.mappingVerified, true);

  const matchingBinding = verifyExactChannexChannel({
    payload: exactChannel({ listingId: "123456789" }),
    ...expected,
    expectedAirbnbListingId: "123456789",
  });
  assert.equal(matchingBinding.airbnbListingId, "123456789");
  assert.equal(matchingBinding.mappingVerified, true);

  const conflictingBinding = verifyExactChannexChannel({
    payload: exactChannel({ listingId: "123456789" }),
    ...expected,
    expectedAirbnbListingId: "987654321",
  });
  assert.equal(conflictingBinding.airbnbListingId, "123456789");
  assert.equal(conflictingBinding.airbnbListingVerified, false);
  assert.equal(conflictingBinding.outboundMappingVerified, false);
  assert.equal(conflictingBinding.mappingVerified, false);
  assert.ok(
    conflictingBinding.reasons.includes("CHANNEL_AIRBNB_LISTING_NOT_VERIFIED")
  );
});

test("Airbnb listing ids reject coercion, surrounding space and control characters", () => {
  for (const listingId of [123456789, " 123456789", "123\n456"]) {
    const result = verifyExactChannexChannel({
      payload: exactChannel({ listingId }),
      ...expected,
    });
    assert.equal(result.airbnbListingId, null);
    assert.equal(result.airbnbListingVerified, false);
    assert.equal(result.mappingVerified, false);
  }
  assert.throws(
    () =>
      verifyExactChannexChannel({
        payload: exactChannel(),
        ...expected,
        expectedAirbnbListingId: "invalid\nlisting",
      }),
    (error: unknown) =>
      error instanceof ChannexChannelIdentityError &&
      error.code === "OTA_CHANNEL_EXPECTED_AIRBNB_LISTING_ID_INVALID"
  );
});

test("duplicate expected rate plans cannot produce an ambiguous Airbnb binding", () => {
  const result = verifyExactChannexChannel({
    payload: exactChannel({
      ratePlans: [
        {
          id: OUTBOUND_MAPPING_ID,
          rate_plan_id: RATE_PLAN_ID,
          settings: { listing_id: "listing-a" },
        },
        {
          id: "66666666-6666-4666-8666-666666666667",
          rate_plan_id: RATE_PLAN_ID,
          settings: { listing_id: "listing-b" },
        },
      ],
    }),
    ...expected,
  });
  assert.equal(result.airbnbListingId, null);
  assert.equal(result.mappingVerified, false);
});

test("duplicate expected rate plans remain ambiguous even with the same Airbnb listing id", () => {
  const result = verifyExactChannexChannel({
    payload: exactChannel({
      ratePlans: [
        {
          id: OUTBOUND_MAPPING_ID,
          rate_plan_id: RATE_PLAN_ID,
          settings: { listing_id: "same-listing" },
        },
        {
          id: "66666666-6666-4666-8666-666666666667",
          rate_plan_id: RATE_PLAN_ID,
          settings: { listing_id: "same-listing" },
        },
      ],
    }),
    ...expected,
  });
  assert.equal(result.airbnbListingId, null);
  assert.equal(result.airbnbListingVerified, false);
  assert.equal(result.outboundMappingVerified, false);
  assert.equal(result.mappingVerified, false);
  assert.ok(result.reasons.includes("CHANNEL_AIRBNB_LISTING_NOT_VERIFIED"));
  assert.ok(result.reasons.includes("CHANNEL_MAPPING_NOT_VERIFIED"));
});

test("non-Airbnb channels expose no Airbnb listing and apply no listing gate", () => {
  const result = verifyExactChannexChannel({
    payload: exactChannel({
      channel: "BookingCom",
      ratePlans: [
        {
          id: OUTBOUND_MAPPING_ID,
          rate_plan_id: RATE_PLAN_ID,
          settings: {},
        },
      ],
    }),
    ...expected,
    provider: "BOOKING_COM",
    expectedAirbnbListingId: "ignored-for-non-airbnb",
  });
  assert.equal(result.airbnbListingId, null);
  assert.equal(result.airbnbListingVerified, true);
  assert.equal(result.outboundMappingVerified, true);
  assert.equal(result.mappingVerified, true);
});

test("outbound rate plans require documented id, rate_plan_id and settings", () => {
  for (const ratePlans of [
    [
      {
        rate_plan_id: RATE_PLAN_ID,
        settings: { listing_id: "listing" },
      },
    ],
    [
      {
        id: OUTBOUND_MAPPING_ID,
        settings: { listing_id: "listing" },
      },
    ],
    [{ id: OUTBOUND_MAPPING_ID, rate_plan_id: RATE_PLAN_ID }],
  ]) {
    assert.throws(
      () =>
        verifyExactChannexChannel({
          payload: exactChannel({ ratePlans }),
          ...expected,
        }),
      (error: unknown) =>
        error instanceof ChannexChannelIdentityError &&
        error.code === "OTA_CHANNEL_RESOURCE_RESPONSE_INVALID"
    );
  }
});
