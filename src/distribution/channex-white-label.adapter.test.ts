import assert from "node:assert/strict";
import test from "node:test";

import {
  ChannexWhiteLabelAdapter,
  WhiteLabelAdapterError,
  type WhiteLabelTransportRequest,
} from "./channex-white-label.adapter.js";

function adapter(enabled: boolean) {
  const requests: WhiteLabelTransportRequest[] = [];
  const responses = [
    { data: { id: "group-ext" } },
    { data: { id: "property-ext" } },
    { data: { id: "room-ext" } },
    { data: { id: "rate-ext" } },
    { data: { attributes: { token: "secret-one-time-token" } } },
  ];
  return {
    requests,
    value: new ChannexWhiteLabelAdapter({
      enabled,
      apiKey: "test-api-key",
      iframeBaseUrl: "https://iframe.example.test/connect",
      channelFilterByProvider: {
        AIRBNB: "airbnb-channel-code",
        BOOKING_COM: "booking-channel-code",
      },
      transport: {
        async send(request) {
          requests.push(request);
          return responses[requests.length - 1];
        },
      },
    }),
  };
}

test("default-off adapter performs zero transport calls", async () => {
  const { value, requests } = adapter(false);
  await assert.rejects(
    value.ensureGroup({ organizationId: "org-1", organizationName: "Pin Go", existingExternalGroupId: null }),
    (error: unknown) => error instanceof WhiteLabelAdapterError && error.code === "OTA_CONNECTION_CENTER_RUNTIME_DISABLED"
  );
  assert.deepEqual(requests, []);
});

test("provisioning contract is group then property, room and rate", async () => {
  const { value, requests } = adapter(true);
  const group = await value.ensureGroup({
    organizationId: "org-1",
    organizationName: "Pin Go",
    existingExternalGroupId: null,
  });
  const property = await value.ensureProperty({
    organizationId: "org-1",
    propertyId: "property-1",
    propertyName: "Casa Azul",
    currency: "usd",
    timezone: "America/Puerto_Rico",
    externalGroupId: group.externalGroupId,
    existingExternalPropertyId: null,
  });
  const room = await value.ensurePrimaryRoomType({
    externalPropertyId: property.externalPropertyId,
    existingExternalPrimaryRoomTypeId: null,
  });
  const rate = await value.ensurePrimaryRatePlan({
    externalPropertyId: property.externalPropertyId,
    externalPrimaryRoomTypeId: room.externalPrimaryRoomTypeId,
    currency: "usd",
    existingExternalPrimaryRatePlanId: null,
  });
  assert.deepEqual({ ...property, ...room, ...rate }, {
    externalPropertyId: "property-ext",
    externalPrimaryRoomTypeId: "room-ext",
    externalPrimaryRatePlanId: "rate-ext",
  });
  assert.deepEqual(requests.map((request) => request.path), [
    "/api/v1/groups",
    "/api/v1/properties",
    "/api/v1/room_types",
    "/api/v1/rate_plans",
  ]);
  assert.equal(requests[0]?.headers["user-api-key"], "test-api-key");
  assert.equal("Authorization" in (requests[0]?.headers ?? {}), false);
  assert.deepEqual(requests[2]?.body, {
    room_type: {
      property_id: "property-ext",
      title: "Primary accommodation",
      count_of_rooms: 1,
      occ_adults: 2,
      occ_children: 0,
      occ_infants: 0,
      default_occupancy: 2,
    },
  });
});

test("one-time token request is scoped to group and property", async () => {
  const { value, requests } = adapter(true);
  await value.ensureGroup({ organizationId: "org-1", organizationName: "Pin Go", existingExternalGroupId: null });
  const property = await value.ensureProperty({
    organizationId: "org-1",
    propertyId: "property-1",
    propertyName: "Casa Azul",
    currency: "USD",
    timezone: "America/Puerto_Rico",
    externalGroupId: "group-ext",
    existingExternalPropertyId: null,
  });
  const room = await value.ensurePrimaryRoomType({
    externalPropertyId: property.externalPropertyId,
    existingExternalPrimaryRoomTypeId: null,
  });
  await value.ensurePrimaryRatePlan({
    externalPropertyId: property.externalPropertyId,
    externalPrimaryRoomTypeId: room.externalPrimaryRoomTypeId,
    currency: "USD",
    existingExternalPrimaryRatePlanId: null,
  });
  const issued = await value.issue({
    externalGroupId: "group-ext",
    externalPropertyId: "property-ext",
    provider: "AIRBNB",
  });
  assert.equal(issued.token, "secret-one-time-token");
  assert.deepEqual(requests.at(-1)?.body, {
    one_time_token: { group_id: "group-ext", property_id: "property-ext" },
  });
  assert.equal(
    new URL(issued.launchUrl).searchParams.get("channels_filter"),
    "airbnb-channel-code"
  );
});

test("unknown provider filter fails closed before token issuance", async () => {
  const { requests } = adapter(true);
  const value = new ChannexWhiteLabelAdapter({
    enabled: true,
    apiKey: "test-api-key",
    iframeBaseUrl: "https://iframe.example.test/connect",
    channelFilterByProvider: {},
    transport: {
      async send(request) {
        requests.push(request);
        return { data: { attributes: { token: "secret-one-time-token" } } };
      },
    },
  });
  await assert.rejects(
    value.issue({
      externalGroupId: "group-ext",
      externalPropertyId: "property-ext",
      provider: "BOOKING_COM",
    }),
    (error: unknown) =>
      error instanceof WhiteLabelAdapterError &&
      error.code === "OTA_CONNECTION_CHANNEL_FILTER_UNAVAILABLE"
  );
  assert.deepEqual(requests, []);
});

test("partial retry reuses checkpoint IDs without transport calls", async () => {
  const { value, requests } = adapter(true);
  assert.deepEqual(await value.ensureGroup({
    organizationId: "org-1",
    organizationName: "Pin Go",
    existingExternalGroupId: "group-ext",
  }), { externalGroupId: "group-ext" });
  assert.deepEqual(await value.ensureProperty({
    organizationId: "org-1",
    propertyId: "property-1",
    propertyName: "Casa Azul",
    currency: "USD",
    timezone: "America/Puerto_Rico",
    externalGroupId: "group-ext",
    existingExternalPropertyId: "property-ext",
  }), { externalPropertyId: "property-ext" });
  assert.deepEqual(await value.ensurePrimaryRoomType({
    externalPropertyId: "property-ext",
    existingExternalPrimaryRoomTypeId: "room-ext",
  }), { externalPrimaryRoomTypeId: "room-ext" });
  assert.deepEqual(await value.ensurePrimaryRatePlan({
    externalPropertyId: "property-ext",
    externalPrimaryRoomTypeId: "room-ext",
    currency: "USD",
    existingExternalPrimaryRatePlanId: "rate-ext",
  }), { externalPrimaryRatePlanId: "rate-ext" });
  assert.deepEqual(requests, []);
});

test("malformed success evidence is classified as reconciliation required", async () => {
  const value = new ChannexWhiteLabelAdapter({
    enabled: true,
    apiKey: "test-api-key",
    iframeBaseUrl: "https://staging.channex.io/channels",
    channelFilterByProvider: { AIRBNB: "airbnb-explicit-filter" },
    transport: { async send() { return { data: {} }; } },
  });
  await assert.rejects(
    value.ensureGroup({
      organizationId: "org-1",
      organizationName: "Pin Go",
      existingExternalGroupId: null,
    }),
    (error: unknown) =>
      error instanceof WhiteLabelAdapterError &&
      error.code === "OTA_PROVIDER_GROUP_RESPONSE_INVALID" &&
      error.retryDisposition === "RECONCILIATION_REQUIRED"
  );
});
