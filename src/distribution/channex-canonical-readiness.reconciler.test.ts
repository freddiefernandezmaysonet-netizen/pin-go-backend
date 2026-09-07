import assert from "node:assert/strict";
import test from "node:test";

import { deriveCanonicalOtaReadiness } from "./channex-canonical-readiness.reconciler.js";

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    provider: "AIRBNB" as const,
    expectedPropertyId: "prop-ext",
    expectedRoomTypeId: "room-ext",
    expectedRatePlanId: "rate-ext",
    externalConnectionId: "channel-ext",
    externalChannelCode: "ABB",
    propertyPayload: { data: { id: "prop-ext", attributes: { acc_channels_count: 1 } } },
    roomTypesPayload: { data: [{ id: "room-ext", attributes: {} }] },
    ratePlansPayload: { data: [{ id: "rate-ext", attributes: {} }] },
    latestLifecycleEvent: "activate_channel" as const,
    ...overrides,
  };
}

test("promotes all readiness only with canonical inventory + channel identity + activation evidence", () => {
  assert.deepEqual(deriveCanonicalOtaReadiness(evidence()), {
    authorizationReadiness: "READY",
    mappingReadiness: "READY",
    distributionReadiness: "READY",
    reasons: [],
  });
});

test("connected channel count alone never proves Airbnb authorization", () => {
  const result = deriveCanonicalOtaReadiness(evidence({ externalConnectionId: null }));
  assert.equal(result.authorizationReadiness, "IN_PROGRESS");
  assert.equal(result.distributionReadiness, "IN_PROGRESS");
});

test("inventory mismatch blocks mapping promotion", () => {
  const result = deriveCanonicalOtaReadiness(evidence({ roomTypesPayload: { data: [] } }));
  assert.equal(result.mappingReadiness, "IN_PROGRESS");
  assert.equal(result.distributionReadiness, "IN_PROGRESS");
  assert.ok(result.reasons.includes("ROOM_TYPE_NOT_CANONICALLY_VERIFIED"));
});

test("positive lifecycle event other than activation does not promote distribution", () => {
  const result = deriveCanonicalOtaReadiness(evidence({ latestLifecycleEvent: "updated_channel" }));
  assert.equal(result.authorizationReadiness, "READY");
  assert.equal(result.mappingReadiness, "READY");
  assert.equal(result.distributionReadiness, "IN_PROGRESS");
});

test("deactivate event blocks distribution fail-closed", () => {
  const result = deriveCanonicalOtaReadiness(evidence({ latestLifecycleEvent: "deactivate_channel" }));
  assert.equal(result.distributionReadiness, "BLOCKED");
});

test("disconnect listing blocks mapping and distribution", () => {
  const result = deriveCanonicalOtaReadiness(evidence({ latestLifecycleEvent: "disconnect_listing" }));
  assert.equal(result.mappingReadiness, "BLOCKED");
  assert.equal(result.distributionReadiness, "BLOCKED");
});

test("disconnected channel resets authorization and blocks downstream readiness", () => {
  const result = deriveCanonicalOtaReadiness(evidence({ latestLifecycleEvent: "disconnected_channel" }));
  assert.equal(result.authorizationReadiness, "REQUIRED");
  assert.equal(result.mappingReadiness, "BLOCKED");
  assert.equal(result.distributionReadiness, "BLOCKED");
});
