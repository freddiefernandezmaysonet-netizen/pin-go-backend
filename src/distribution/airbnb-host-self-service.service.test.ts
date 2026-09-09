import assert from "node:assert/strict";
import test from "node:test";

import {
  AirbnbHostSelfServiceError,
  createAirbnbHostState,
  issueAirbnbHostConnectionLink,
  verifyAirbnbHostCallback,
  verifyAirbnbHostState,
} from "./airbnb-host-self-service.service.js";

const SECRET = "test-only-state-secret-that-is-long-enough-1234567890";
const NOW = new Date("2026-09-09T05:00:00.000Z");
const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const PROPERTY_ID = "22222222-2222-4222-8222-222222222222";
const CHANNEL_ID = "33333333-3333-4333-8333-333333333333";

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
          group: {
            organizationId: "org-1",
            platform: "CHANNEX",
            externalGroupId: GROUP_ID,
          },
        };
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
        return { data: { attributes: { url: "https://app.channex.io/airbnb/authorize/example" } } };
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

  assert.equal(result.authorizationUrl, "https://app.channex.io/airbnb/authorize/example");
  const root = requestBody as any;
  assert.equal(root.connection_link.group_id, GROUP_ID);
  assert.deepEqual(root.connection_link.properties, [PROPERTY_ID]);
  assert.equal(root.connection_link.redirect_uri, "https://app.pin-ngo.com/distribution/airbnb/callback");
  assert.equal(root.connection_link.failure_redirect_uri, "https://app.pin-ngo.com/distribution/airbnb/callback");
  assert.equal(typeof root.connection_link.token, "string");
  assert.ok(root.connection_link.token.length > 40);
});

test("connection link rejects an authorization URL outside configured Channex origin", async () => {
  await assert.rejects(
    () => issueAirbnbHostConnectionLink({
      client: client(),
      transport: {
        async createConnectionLink() {
          return { data: { attributes: { url: "https://evil.example/steal" } } };
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
    }),
    (error: unknown) => error instanceof AirbnbHostSelfServiceError && error.code === "OTA_AIRBNB_CONNECTION_LINK_RESPONSE_INVALID"
  );
});

test("successful callback verifies exact channel and stops at mapping required", async () => {
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
    transport: {
      async createConnectionLink() { throw new Error("not used"); },
      async getChannel(channelId) {
        requestedChannel = channelId;
        return { data: { id: channelId, attributes: { channel: "airbnb", is_active: false } } };
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
