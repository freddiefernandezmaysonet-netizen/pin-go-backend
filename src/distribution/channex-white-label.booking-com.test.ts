import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannexWhiteLabelAdapter,
  WhiteLabelAdapterError,
  type WhiteLabelTransportRequest,
} from "./channex-white-label.adapter.js";

const scope = { externalGroupId: "group-booking", externalPropertyId: "property-booking" };

function setup(options: { enabled?: boolean; filter?: string; tokenShape?: "root" | "attributes" } = {}) {
  const requests: WhiteLabelTransportRequest[] = [];
  const value = new ChannexWhiteLabelAdapter({
    enabled: options.enabled ?? true,
    apiKey: "test-key-not-for-the-browser",
    iframeBaseUrl: "https://staging.channex.io/channels?available_channels=ABB#old",
    channelFilterByProvider: { AIRBNB: "ABB", BOOKING_COM: options.filter ?? "BDC" },
    transport: {
      async send(request) {
        requests.push(request);
        const token = `test-token-${requests.length}`;
        return options.tokenShape === "attributes"
          ? { data: { attributes: { token } } }
          : { data: { token } };
      },
    },
  });
  return { value, requests };
}

// Channex Channel IFrame documents BDC, channels_filter and available_channels:
// https://docs.channex.io/api-v.1-documentation/channel-iframe
for (const tokenShape of ["root", "attributes"] as const) {
  test(`Booking.com filters both displayed and configurable channels (${tokenShape} token)`, async () => {
    const { value, requests } = setup({ tokenShape });
    const issued = await value.issue({ ...scope, provider: "BOOKING_COM" });
    const url = new URL(issued.launchUrl);
    assert.equal(url.searchParams.get("channels_filter"), "BDC");
    assert.equal(url.searchParams.get("available_channels"), "BDC");
    assert.equal(url.origin, "https://staging.channex.io");
    assert.equal(url.pathname, "/auth/exchange");
    assert.equal(url.hash, "");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      oauth_session_key: "test-token-1",
      app_mode: "headless",
      redirect_to: "/channels",
      property_id: scope.externalPropertyId,
      group_id: scope.externalGroupId,
      channels_filter: "BDC",
      available_channels: "BDC",
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.path, "/api/v1/auth/one_time_token");
    assert.equal(requests[0]?.method, "POST");
    assert.deepEqual(requests[0]?.body, {
      one_time_token: { group_id: scope.externalGroupId, property_id: scope.externalPropertyId },
    });
    assert.equal(requests[0]?.headers["user-api-key"], "test-key-not-for-the-browser");
    assert.equal(issued.launchUrl.includes("test-key-not-for-the-browser"), false);
  });
}

test("Booking.com session generation requests no mapping, activation, ARI or booking import", async () => {
  const { value, requests } = setup();
  await value.issue({ ...scope, provider: "BOOKING_COM" });
  assert.deepEqual(requests.map(({ method, path }) => ({ method, path })), [
    { method: "POST", path: "/api/v1/auth/one_time_token" },
  ]);
});

test("Airbnb launch URL and token request remain byte-for-byte compatible", async () => {
  const { value, requests } = setup();
  const issued = await value.issue({ ...scope, provider: "AIRBNB" });
  assert.equal(issued.launchUrl,
    "https://staging.channex.io/auth/exchange?oauth_session_key=test-token-1&app_mode=headless&redirect_to=%2Fchannels&property_id=property-booking&group_id=group-booking&channels_filter=ABB");
  assert.equal(new URL(issued.launchUrl).searchParams.has("available_channels"), false);
  assert.equal(requests.length, 1);
});

test("each Booking.com launch keeps its own group, property and issued token", async () => {
  const { value } = setup();
  const first = new URL((await value.issue({ ...scope, provider: "BOOKING_COM" })).launchUrl);
  const second = new URL((await value.issue({
    externalGroupId: "group-other", externalPropertyId: "property-other", provider: "BOOKING_COM",
  })).launchUrl);
  assert.equal(first.searchParams.get("group_id"), "group-booking");
  assert.equal(first.searchParams.get("property_id"), "property-booking");
  assert.equal(second.searchParams.get("group_id"), "group-other");
  assert.equal(second.searchParams.get("property_id"), "property-other");
  assert.notEqual(first.searchParams.get("oauth_session_key"), second.searchParams.get("oauth_session_key"));
  assert.equal(first.searchParams.get("available_channels"), "BDC");
  assert.equal(second.searchParams.get("available_channels"), "BDC");
});

test("Booking.com preserves default-off behavior without a transport call", async () => {
  const { value, requests } = setup({ enabled: false });
  await assert.rejects(value.issue({ ...scope, provider: "BOOKING_COM" }),
    (error: unknown) => error instanceof WhiteLabelAdapterError && error.code === "OTA_CONNECTION_CENTER_RUNTIME_DISABLED");
  assert.deepEqual(requests, []);
});

test("Booking.com rejects an empty configured filter before issuing a token", async () => {
  const { value, requests } = setup({ filter: " " });
  await assert.rejects(value.issue({ ...scope, provider: "BOOKING_COM" }),
    (error: unknown) => error instanceof WhiteLabelAdapterError && error.code === "OTA_CONNECTION_CHANNEL_FILTER_UNAVAILABLE");
  assert.deepEqual(requests, []);
});

for (const field of ["externalGroupId", "externalPropertyId"] as const) {
  test(`Booking.com rejects missing ${field} before a transport call`, async () => {
    const { value, requests } = setup();
    await assert.rejects(value.issue({ ...scope, [field]: "", provider: "BOOKING_COM" }), WhiteLabelAdapterError);
    assert.deepEqual(requests, []);
  });
}
