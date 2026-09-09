import assert from "node:assert/strict";
import test from "node:test";

import {
  AirbnbHostSelfServiceError,
  createAirbnbHostState,
  issueAirbnbHostConnectionLink,
  verifyAirbnbHostCallback,
  verifyAirbnbHostState,
} from "./airbnb-host-self-service.service.js";

// Literal 200 JSON from the supplied Channex Airbnb guide, lines 123-131.
// example.com is the documentation placeholder, NOT an asserted Airbnb endpoint.
const DOCUMENTED_CONNECTION_LINK = JSON.parse(`{
  "data": {
    "type": "connection_link",
    "attributes": {
      "url": "https://example.com"
    }
  }
}`);

const SECRET = "test-only-state-secret-that-is-long-enough-1234567890";
const NOW = new Date("2026-09-09T05:00:00.000Z");
// group_id/properties copied from the documented request (lines 97-100).
const GROUP_ID = "a60df2a7-fbaf-49b5-a8bb-35e736d5e24d";
const PROPERTY_ID = "1519fa73-a0f4-44f3-ab8d-d29412834588";
const CHANNEL_ID = "33333333-3333-4333-8333-333333333333";
const ROOM_TYPE_ID = "44444444-4444-4444-8444-444444444444";
const RATE_PLAN_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_PROPERTY_ID = "66666666-6666-4666-8666-666666666666";

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
          externalPrimaryRoomTypeId: ROOM_TYPE_ID,
          externalPrimaryRatePlanId: RATE_PLAN_ID,
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

// Existing synthetic callback regression fixture, NOT the literal GET example.
// Document-exact callback identity is a separate, still-open gate.
function exactAirbnbChannelPayload(
  channelId = CHANNEL_ID,
  propertyId = PROPERTY_ID
) {
  return {
    data: {
      id: channelId,
      type: "channel",
      attributes: {
        id: channelId,
        channel: "Airbnb",
        properties: [propertyId],
        is_active: false,
        rate_plans: [],
      },
      relationships: {
        properties: {
          data: [{ id: propertyId, type: "property" }],
        },
        group: {
          data: { id: GROUP_ID, type: "group" },
        },
        known_mappings: {
          data: [],
        },
      },
    },
  };
}

test("state is tenant/user bound, signed and expires after two hours", () => {
  const token = createAirbnbHostState({
    secret: SECRET,
    organizationId: "org-1",
    propertyId: "property-1",
    requestedByUserId: "user-1",
    now: NOW,
    nonce: "fixed-nonce",
  });
  const claims = verifyAirbnbHostState({
    token,
    secret: SECRET,
    organizationId: "org-1",
    requestedByUserId: "user-1",
    now: new Date(NOW.getTime() + 60_000),
  });
  assert.equal(claims.propertyId, "property-1");
  assert.equal(claims.expiresAt - claims.issuedAt, 2 * 60 * 60 * 1_000);

  assert.throws(
    () => verifyAirbnbHostState({ token, secret: SECRET, organizationId: "org-other", requestedByUserId: "user-1", now: NOW }),
    (error: unknown) => error instanceof AirbnbHostSelfServiceError && error.code === "OTA_AIRBNB_STATE_INVALID"
  );
  assert.throws(
    () => verifyAirbnbHostState({ token, secret: SECRET, organizationId: "org-1", requestedByUserId: "user-1", now: new Date(NOW.getTime() + 2 * 60 * 60 * 1_000 + 1) }),
    (error: unknown) => error instanceof AirbnbHostSelfServiceError && error.code === "OTA_AIRBNB_STATE_INVALID"
  );
});

test("connection link request follows Channex host self-service contract", async () => {
  let requestBody: unknown;
  const result = await issueAirbnbHostConnectionLink({
    client: client(),
    transport: {
      async createConnectionLink(body) {
        requestBody = body;
        return structuredClone(DOCUMENTED_CONNECTION_LINK);
      },
      async getChannel() { throw new Error("not used"); },
    },
    stateSecret: SECRET,
    callbackOrigin: "https://app.pin-ngo.com",
    providerOrigin: "https://app.channex.io",
    organizationId: "org-1",
    propertyId: "property-1",
    requestedByUserId: "user-1",
    now: NOW,
  });

  assert.equal(result.authorizationUrl, DOCUMENTED_CONNECTION_LINK.data.attributes.url);
  assert.equal(result.authorizationUrl, "https://example.com");
  assert.equal(result.expiresAt.getTime(), NOW.getTime() + 2 * 60 * 60 * 1_000);
  const root = requestBody as any;
  assert.equal(root.connection_link.group_id, GROUP_ID);
  assert.deepEqual(root.connection_link.properties, [PROPERTY_ID]);
  assert.equal(root.connection_link.redirect_uri, "https://app.pin-ngo.com/distribution/airbnb/callback");
  assert.equal(root.connection_link.failure_redirect_uri, "https://app.pin-ngo.com/distribution/airbnb/callback");
  assert.equal(typeof root.connection_link.token, "string");
  assert.ok(root.connection_link.token.length > 40);
  assert.deepEqual(Object.keys(root.connection_link).sort(), [
    "failure_redirect_uri", "group_id", "properties", "redirect_uri", "token",
  ]);
  const claims = verifyAirbnbHostState({
    token: root.connection_link.token, secret: SECRET,
    organizationId: "org-1", requestedByUserId: "user-1", now: NOW,
  });
  assert.equal(claims.propertyId, "property-1");
});

// These cases mutate only the documented URL/payload. They are security and
// preservation probes, not examples of actual provider responses or endpoints.
async function issueWithPayload(payload: unknown, providerOrigin = "https://app.channex.io") {
  let linkRequests = 0;
  const result = await issueAirbnbHostConnectionLink({
    client: client(),
    transport: {
      async createConnectionLink() { linkRequests += 1; return payload; },
      async getChannel() { throw new Error("handoff must not read a channel"); },
    },
    stateSecret: SECRET,
    callbackOrigin: "https://app.pin-ngo.com",
    providerOrigin,
    organizationId: "org-1",
    propertyId: "property-1",
    requestedByUserId: "user-1",
    now: NOW,
  });
  assert.equal(linkRequests, 1);
  return result;
}

for (const providerOrigin of ["https://app.channex.io", "https://staging.channex.io"]) {
  test(`documented authorization URL is independent of API origin: ${providerOrigin}`, async () => {
    const result = await issueWithPayload(structuredClone(DOCUMENTED_CONNECTION_LINK), providerOrigin);
    assert.equal(result.authorizationUrl, "https://example.com");
  });
}

for (const [label, url] of [
  ["query order, encoding, repeated keys and fragment", "https://example.com?token=a%2Fb+c&scope=one%20two&scope=three#resume"],
  ["original host case and default port", "https://EXAMPLE.com:443?token=test"],
  ["no undocumented 4096-character cap", `https://example.com?token=${"x".repeat(5000)}`],
]) {
  test(`synthetic URL preservation: ${label}`, async () => {
    const payload = structuredClone(DOCUMENTED_CONNECTION_LINK);
    payload.data.attributes.url = url;
    assert.equal((await issueWithPayload(payload)).authorizationUrl, url);
  });
}

const unsafeUrls: Array<[string, unknown]> = [
  ["HTTP", "http://example.com"],
  ["javascript", "javascript:alert(1)"],
  ["data", "data:text/html,test"],
  ["file", "file:///tmp/test"],
  ["protocol-relative", "//example.com"],
  ["relative", "/authorize"],
  ["username", "https://owner@example.com"],
  ["password", "https://owner:secret@example.com"],
  ["malformed host", "https://[invalid"],
  ["empty", ""],
  ["null", null],
  ["number", 1],
  ["array", ["https://example.com"]],
  ["object", { url: "https://example.com" }],
];
for (const [label, url] of unsafeUrls) {
  test(`synthetic invalid authorization URL is rejected: ${label}`, async () => {
    const payload = structuredClone(DOCUMENTED_CONNECTION_LINK);
    payload.data.attributes.url = url;
    await assert.rejects(() => issueWithPayload(payload), (error: unknown) =>
      error instanceof AirbnbHostSelfServiceError &&
      error.code === "OTA_AIRBNB_CONNECTION_LINK_RESPONSE_INVALID"
    );
  });
}

for (const [label, payload] of [
  ["missing payload", null], ["missing data", {}], ["array data", { data: [] }],
  ["missing attributes", { data: { type: "connection_link" } }],
  ["missing url", { data: { attributes: {} } }],
] as Array<[string, unknown]>) {
  test(`synthetic malformed provider envelope is rejected: ${label}`, async () => {
    await assert.rejects(() => issueWithPayload(payload), (error: unknown) =>
      error instanceof AirbnbHostSelfServiceError &&
      error.code === "OTA_AIRBNB_CONNECTION_LINK_RESPONSE_INVALID"
    );
  });
}

test("invalid provider/callback configuration still fails before any transport call", async () => {
  let calls = 0;
  const base = {
    client: client(),
    transport: {
      async createConnectionLink() { calls += 1; return DOCUMENTED_CONNECTION_LINK; },
      async getChannel() { throw new Error("not used"); },
    },
    stateSecret: SECRET, callbackOrigin: "https://app.pin-ngo.com",
    providerOrigin: "https://app.channex.io", organizationId: "org-1",
    propertyId: "property-1", requestedByUserId: "user-1", now: NOW,
  };
  await assert.rejects(() => issueAirbnbHostConnectionLink({ ...base, providerOrigin: "http://app.channex.io" }),
    (error: unknown) => error instanceof AirbnbHostSelfServiceError && error.code === "OTA_AIRBNB_PROVIDER_ORIGIN_INVALID");
  await assert.rejects(() => issueAirbnbHostConnectionLink({ ...base, callbackOrigin: "https://app.pin-ngo.com/other" }),
    (error: unknown) => error instanceof AirbnbHostSelfServiceError && error.code === "OTA_AIRBNB_CALLBACK_ORIGIN_INVALID");
  assert.equal(calls, 0);
});

test("upstream errors are propagated without fabricating a URL or retrying", async () => {
  let calls = 0;
  const upstreamError = new Error("mock upstream failure");
  await assert.rejects(() => issueAirbnbHostConnectionLink({
    client: client(),
    transport: {
      async createConnectionLink() { calls += 1; throw upstreamError; },
      async getChannel() { throw new Error("not used"); },
    },
    stateSecret: SECRET, callbackOrigin: "https://app.pin-ngo.com",
    providerOrigin: "https://app.channex.io", organizationId: "org-1",
    propertyId: "property-1", requestedByUserId: "user-1", now: NOW,
  }), (error: unknown) => error === upstreamError);
  assert.equal(calls, 1);
});

test("successful callback verifies exact channel identity and stops at mapping required", async () => {
  const token = createAirbnbHostState({
    secret: SECRET,
    organizationId: "org-1",
    propertyId: "property-1",
    requestedByUserId: "user-1",
    now: NOW,
    nonce: "fixed-nonce",
  });
  let requestedChannel: string | null = null;
  const result = await verifyAirbnbHostCallback({
    client: client(),
    transport: {
      async createConnectionLink() { throw new Error("not used"); },
      async getChannel(channelId) {
        requestedChannel = channelId;
        return exactAirbnbChannelPayload(channelId);
      },
    },
    stateSecret: SECRET,
    organizationId: "org-1",
    requestedByUserId: "user-1",
    success: "true",
    channelId: CHANNEL_ID,
    token,
    now: new Date(NOW.getTime() + 60_000),
  });

  assert.equal(requestedChannel, CHANNEL_ID);
  assert.deepEqual(result, {
    success: true,
    propertyId: "property-1",
    channelId: CHANNEL_ID,
    channelActive: false,
    nextAction: "MAPPING_REQUIRED",
  });
});

test("callback rejects an Airbnb channel belonging to a different Channex property", async () => {
  const token = createAirbnbHostState({
    secret: SECRET,
    organizationId: "org-1",
    propertyId: "property-1",
    requestedByUserId: "user-1",
    now: NOW,
    nonce: "fixed-nonce",
  });

  await assert.rejects(
    () => verifyAirbnbHostCallback({
      client: client(),
      transport: {
        async createConnectionLink() { throw new Error("not used"); },
        async getChannel(channelId) {
          return exactAirbnbChannelPayload(channelId, OTHER_PROPERTY_ID);
        },
      },
      stateSecret: SECRET,
      organizationId: "org-1",
      requestedByUserId: "user-1",
      success: "true",
      channelId: CHANNEL_ID,
      token,
      now: new Date(NOW.getTime() + 60_000),
    }),
    (error: unknown) =>
      error instanceof AirbnbHostSelfServiceError &&
      error.code === "OTA_AIRBNB_CHANNEL_IDENTITY_NOT_VERIFIED"
  );
});

test("failed callback does not fetch a channel or claim success", async () => {
  const token = createAirbnbHostState({
    secret: SECRET,
    organizationId: "org-1",
    propertyId: "property-1",
    requestedByUserId: "user-1",
    now: NOW,
    nonce: "fixed-nonce",
  });
  let channelReads = 0;
  const result = await verifyAirbnbHostCallback({
    client: client(),
    transport: {
      async createConnectionLink() { throw new Error("not used"); },
      async getChannel() { channelReads += 1; return {}; },
    },
    stateSecret: SECRET,
    organizationId: "org-1",
    requestedByUserId: "user-1",
    success: "false",
    token,
    now: new Date(NOW.getTime() + 60_000),
  });
  assert.equal(channelReads, 0);
  assert.equal(result.success, false);
  assert.equal(result.nextAction, "RETRY_AUTHORIZATION");
});
