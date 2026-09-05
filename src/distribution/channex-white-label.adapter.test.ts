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
  const inventory = await value.ensurePropertyInventory({
    organizationId: "org-1",
    propertyId: "property-1",
    propertyName: "Casa Azul",
    currency: "usd",
    timezone: "America/Puerto_Rico",
    externalGroupId: group.externalGroupId,
    existingExternalPropertyId: null,
  });
  assert.deepEqual(inventory, {
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
});

test("one-time token request is scoped to group and property", async () => {
  const { value, requests } = adapter(true);
  await value.ensureGroup({ organizationId: "org-1", organizationName: "Pin Go", existingExternalGroupId: null });
  await value.ensurePropertyInventory({
    organizationId: "org-1",
    propertyId: "property-1",
    propertyName: "Casa Azul",
    currency: "USD",
    timezone: "America/Puerto_Rico",
    externalGroupId: "group-ext",
    existingExternalPropertyId: null,
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
  assert.match(issued.launchUrl, /channels_filter=AIRBNB/);
});
