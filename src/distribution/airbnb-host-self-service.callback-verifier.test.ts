import assert from "node:assert/strict";
import test from "node:test";
import { verifyAirbnbCallbackChannelResource, AirbnbCallbackChannelVerificationError } from "./airbnb-host-self-service.callback-verifier.js";
import { createAirbnbHostState, verifyAirbnbHostCallback, AirbnbHostSelfServiceError } from "./airbnb-host-self-service.service.js";
import { verifyExactChannexChannel, ChannexChannelIdentityError } from "./channex-channel-identity.js";

// Literal GET /channels/{id} example from the supplied guide, L255–323.
// Kept BookingCom, is_active=true, and unequal IDs. Synthetic mutations below
// probe boundaries; none is represented as real Airbnb/provider evidence.
const DOCUMENTED_CHANNEL = {
  "data": {
    "type": "channel",
    "id": "716305c4-561a-4561-a187-7f5b8aeb5920",
    "attributes": {
      "id": "96177287-c3b2-4d98-9eb7-5c1927795825",
      "title": "Booking.com - Main",
      "channel": "BookingCom",
      "currency": "USD",
      "is_active": true,
      "settings": {
        "derived_option": {}
      },
      "rate_plans": [
        {
          "id": "b217a47d-c282-4591-a873-7758f2883237",
          "rate_plan_id": "7e9409b4-160b-4412-941f-09c2c205b13b",
          "settings": {
            "derived_option": {}
          }
        }
      ],
      "properties": [
        "daec1c06-a9f6-4a25-88fa-cc4e9dbea436"
      ],
      "actions": [
        "load_future_reservations"
      ],
      "expected_removal_date": "2026-08-17",
      "inserted_at": "2026-08-12T10:12:04.740476",
      "updated_at": "2026-08-12T10:14:37.786888",
      "status": "active"
    },
    "relationships": {
      "group": {
        "data": {
          "id": "5b79c003-a0b0-45b5-8428-e006a26b6a82",
          "type": "group"
        }
      },
      "properties": {
        "data": [
          {
            "id": "daec1c06-a9f6-4a25-88fa-cc4e9dbea436",
            "type": "property"
          }
        ]
      },
      "known_mappings": {
        "data": [
          {
            "id": "d1a48009-fc52-4940-9f68-e7f609b73f01",
            "type": "known_mapping",
            "attributes": {
              "id": "d1a48009-fc52-4940-9f68-e7f609b73f01",
              "type": "auto",
              "rate_plan_code": "text",
              "room_type_code": "text",
              "rate_plan_id": "7e9409b4-160b-4412-941f-09c2c205b13b",
              "room_type_id": "06ededd7-16c1-40f7-97ee-b98bf8796fb9"
            }
          }
        ]
      }
    }
  }
};
const expected = {
  expectedChannelId: DOCUMENTED_CHANNEL.data.id,
  expectedPropertyId: DOCUMENTED_CHANNEL.data.attributes.properties[0]!,
  expectedGroupId: DOCUMENTED_CHANNEL.data.relationships.group.data.id,
};
const OTHER_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-09T05:00:00Z");
const SECRET = "test-only-gate2-state-secret-not-a-real-secret-12345";
function parse(payload: unknown = structuredClone(DOCUMENTED_CHANNEL), overrides = {}) {
  return verifyAirbnbCallbackChannelResource({ payload, ...expected, ...overrides });
}
function state() {
  return createAirbnbHostState({ secret: SECRET, organizationId: "org-1", propertyId: "property-1", requestedByUserId: "user-1", now: NOW, nonce: "test-only" });
}
function harness(payload: unknown = structuredClone(DOCUMENTED_CHANNEL)) {
  const calls: string[] = [];
  const args = {
    client: { distributionProperty: { async findFirst(query: any) {
      calls.push("property-read");
      assert.deepEqual(query.where, { organizationId: "org-1", propertyId: "property-1", platform: "CHANNEX" });
      return {
        organizationId: "org-1", propertyId: "property-1", platform: "CHANNEX", provisioningStatus: "READY",
        externalPropertyId: expected.expectedPropertyId,
        externalPrimaryRoomTypeId: null, externalPrimaryRatePlanId: null,
        group: { organizationId: "org-1", platform: "CHANNEX", provisioningStatus: "READY", externalGroupId: expected.expectedGroupId },
      };
    } } },
    transport: {
      async getChannel(id: string) { calls.push(`GET:${id}`); return payload; },
      async createConnectionLink() { calls.push("FORBIDDEN_POST"); throw new Error("callback must not issue links"); },
    },
    stateSecret: SECRET, organizationId: "org-1", requestedByUserId: "user-1",
    success: "true", channelId: expected.expectedChannelId, token: state(), now: NOW,
  };
  return { args, calls };
}

test("literal GET is a verified resource read, NEVER a verified Airbnb account", () => {
  assert.notEqual(DOCUMENTED_CHANNEL.data.id, DOCUMENTED_CHANNEL.data.attributes.id);
  assert.equal(DOCUMENTED_CHANNEL.data.attributes.channel, "BookingCom");
  const payload = structuredClone(DOCUMENTED_CHANNEL);
  assert.deepEqual(parse(payload), { channelId: expected.expectedChannelId, activeState: true, airbnbAccountVerified: false });
  assert.deepEqual(payload, DOCUMENTED_CHANNEL);
});
for (const key of ["expectedChannelId", "expectedPropertyId", "expectedGroupId"]) {
  test(`synthetic mismatched ${key} fails tenant/resource boundary`, () => {
    assert.throws(() => parse(undefined, { [key]: OTHER_ID }), (e: unknown) =>
      e instanceof AirbnbCallbackChannelVerificationError && e.code === "OTA_AIRBNB_CHANNEL_IDENTITY_NOT_VERIFIED");
  });
}
for (const [label, mutate] of [
  ["wrong resource type", (p: any) => { p.data.type = "property"; }],
  ["missing attributes", (p: any) => { delete p.data.attributes; }],
  ["missing relationships", (p: any) => { delete p.data.relationships; }],
  ["missing group", (p: any) => { delete p.data.relationships.group; }],
  ["wrong group type", (p: any) => { p.data.relationships.group.data.type = "property"; }],
  ["invalid resource id", (p: any) => { p.data.id = "../../other"; }],
  ["invalid attribute property", (p: any) => { p.data.attributes.properties = [1]; }],
  ["invalid relationship property", (p: any) => { p.data.relationships.properties.data = [null]; }],
  ["missing attribute properties", (p: any) => { delete p.data.attributes.properties; }],
  ["missing relationship properties", (p: any) => { delete p.data.relationships.properties; }],
] as Array<[string, (p: any) => void]>) {
  test(`synthetic malformed resource: ${label}`, () => {
    const p = structuredClone(DOCUMENTED_CHANNEL); mutate(p);
    assert.throws(() => parse(p), (e: unknown) => e instanceof AirbnbCallbackChannelVerificationError && e.code === "OTA_AIRBNB_CHANNEL_RESPONSE_INVALID");
  });
}
for (const [label, mutate] of [
  ["attributes exclude expected property", (p: any) => { p.data.attributes.properties = [OTHER_ID]; }],
  ["relationships exclude expected property", (p: any) => { p.data.relationships.properties.data[0].id = OTHER_ID; }],
  ["group substitution", (p: any) => { p.data.relationships.group.data.id = OTHER_ID; }],
] as Array<[string, (p: any) => void]>) {
  test(`synthetic boundary substitution: ${label}`, () => {
    const p = structuredClone(DOCUMENTED_CHANNEL); mutate(p);
    assert.throws(() => parse(p), (e: unknown) => e instanceof AirbnbCallbackChannelVerificationError && e.code === "OTA_AIRBNB_CHANNEL_IDENTITY_NOT_VERIFIED");
  });
}
test("multiple properties are permitted; no invented singleton restriction", () => {
  const p = structuredClone(DOCUMENTED_CHANNEL);
  p.data.attributes.properties.push(OTHER_ID);
  p.data.relationships.properties.data.unshift({ id: OTHER_ID, type: "property" });
  assert.equal(parse(p).airbnbAccountVerified, false);
});
test("ignored attributes.id/mapping/settings/status do not become callback gates or leak", () => {
  const p: any = structuredClone(DOCUMENTED_CHANNEL);
  delete p.data.attributes.id; delete p.data.attributes.channel; delete p.data.attributes.rate_plans;
  p.data.relationships.known_mappings = "not interpreted in this gate";
  p.data.attributes.settings = { access_token: "SYNTHETIC_SENSITIVE_VALUE" };
  p.data.attributes.status = "not interpreted in this gate";
  assert.deepEqual(parse(p), { channelId: expected.expectedChannelId, activeState: true, airbnbAccountVerified: false });
  assert.ok(!JSON.stringify(parse(p)).includes("SYNTHETIC_SENSITIVE_VALUE"));
});
for (const active of [false, null, undefined, "active", 1]) {
  test(`synthetic is_active=${String(active)} never implies promotion`, () => {
    const p: any = structuredClone(DOCUMENTED_CHANNEL); p.data.attributes.is_active = active;
    assert.deepEqual(parse(p), { channelId: expected.expectedChannelId, activeState: active === false ? false : null, airbnbAccountVerified: false });
  });
}
test("service consumes literal resource with no room/rate prerequisites and stops before discovery", async () => {
  const { args, calls } = harness();
  assert.deepEqual(await verifyAirbnbHostCallback(args), {
    success: true, propertyId: "property-1", channelId: expected.expectedChannelId,
    channelActive: true, airbnbAccountVerified: false, nextAction: "LISTING_DISCOVERY_REQUIRED",
  });
  assert.deepEqual(calls, ["property-read", `GET:${expected.expectedChannelId}`]);
});
for (const token of [undefined, null, "", "ignored-invalid-token", state()]) {
  test(`documented success=false is uncorrelated and effect-free (token ${typeof token})`, async () => {
    const { args, calls } = harness();
    assert.deepEqual(await verifyAirbnbHostCallback({ ...args, success: "false", channelId: OTHER_ID, token }), {
      success: false, propertyId: null, channelId: null, channelActive: null,
      airbnbAccountVerified: false, nextAction: "RETRY_AUTHORIZATION",
    });
    assert.deepEqual(calls, []);
  });
}
for (const [label, overrides] of [
  ["missing token", { token: undefined }], ["empty token", { token: "" }],
  ["tampered token", { token: state() + "x" }], ["wrong tenant", { organizationId: "other-org" }],
  ["wrong actor", { requestedByUserId: "other-user" }],
  ["expired state", { now: new Date(NOW.getTime() + 2 * 60 * 60 * 1000 + 1) }],
] as Array<[string, Record<string, unknown>]>) {
  test(`synthetic success without valid state fails before reads: ${label}`, async () => {
    const { args, calls } = harness();
    await assert.rejects(() => verifyAirbnbHostCallback({ ...args, ...overrides }), (e: unknown) => e instanceof AirbnbHostSelfServiceError && e.code === "OTA_AIRBNB_STATE_INVALID");
    assert.deepEqual(calls, []);
  });
}
for (const success of ["", "TRUE", "1", "unknown"]) {
  test(`synthetic undocumented success value ${JSON.stringify(success)} fails closed`, async () => {
    const { args, calls } = harness();
    await assert.rejects(() => verifyAirbnbHostCallback({ ...args, success }), (e: unknown) => e instanceof AirbnbHostSelfServiceError && e.code === "OTA_AIRBNB_CALLBACK_RESULT_INVALID");
    assert.deepEqual(calls, []);
  });
}
test("synthetic different resource is not retried or substituted", async () => {
  const p = structuredClone(DOCUMENTED_CHANNEL); p.data.id = OTHER_ID;
  const { args, calls } = harness(p);
  await assert.rejects(() => verifyAirbnbHostCallback(args), (e: unknown) => e instanceof AirbnbHostSelfServiceError && e.code === "OTA_AIRBNB_CHANNEL_IDENTITY_NOT_VERIFIED");
  assert.deepEqual(calls, ["property-read", `GET:${expected.expectedChannelId}`]);
});
test("upstream GET failure propagates without discovery, retries or writes", async () => {
  const { args, calls } = harness(); const error = new Error("mock-only upstream error");
  args.transport.getChannel = async (id) => { calls.push(`GET:${id}`); throw error; };
  await assert.rejects(() => verifyAirbnbHostCallback(args), (e: unknown) => e === error);
  assert.deepEqual(calls, ["property-read", `GET:${expected.expectedChannelId}`]);
});
test("shared core retains its existing strict ID guarantee on the same literal fixture", () => {
  assert.throws(() => verifyExactChannexChannel({
    payload: structuredClone(DOCUMENTED_CHANNEL), provider: "BOOKING_COM", ...expected,
    expectedRoomTypeId: "06ededd7-16c1-40f7-97ee-b98bf8796fb9",
    expectedRatePlanId: "7e9409b4-160b-4412-941f-09c2c205b13b",
  }), (e: unknown) => e instanceof ChannexChannelIdentityError && e.code === "OTA_CHANNEL_RESOURCE_RESPONSE_INVALID");
});
