import assert from "node:assert/strict";
import test from "node:test";

import { deriveCanonicalOtaReadiness } from "./channex-canonical-readiness.reconciler.js";

function verification(overrides: Record<string, unknown> = {}) {
  return {
    channelId: "channel-ext",
    resourceTypeVerified: true,
    providerVerified: true,
    propertyVerified: true,
    identityVerified: true,
    activeState: true,
    connectedEvidenceVerified: true,
    mappingVerified: true,
    reasons: [],
    ...overrides,
  } as any;
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    provider: "AIRBNB" as const,
    expectedPropertyId: "prop-ext",
    expectedRoomTypeId: "room-ext",
    expectedRatePlanId: "rate-ext",
    propertyPayload: {
      data: {
        type: "property",
        id: "prop-ext",
        attributes: { id: "prop-ext" },
      },
    },
    roomTypePayload: {
      data: {
        type: "room_type",
        id: "room-ext",
        attributes: { id: "room-ext" },
        relationships: {
          property: { data: { type: "property", id: "prop-ext" } },
        },
      },
    },
    ratePlanPayload: {
      data: {
        type: "rate_plan",
        id: "rate-ext",
        attributes: { id: "rate-ext" },
        relationships: {
          property: { data: { type: "property", id: "prop-ext" } },
          room_type: { data: { type: "room_type", id: "room-ext" } },
        },
      },
    },
    channelVerification: verification(),
    latestLifecycleEvent: "activate_channel" as const,
    channelAuthorizationVerifiedAt: new Date("2026-09-07T18:00:00.000Z"),
    lastChannelActivatedAt: new Date("2026-09-07T18:00:00.000Z"),
    ...overrides,
  };
}

test("promotes readiness only with exact channel, exact mapping, active state and activation evidence", () => {
  assert.deepEqual(deriveCanonicalOtaReadiness(evidence()), {
    authorizationReadiness: "READY",
    mappingReadiness: "READY",
    distributionReadiness: "READY",
    reasons: [],
  });
});

test("aggregate property channel count is irrelevant without exact identity", () => {
  const result = deriveCanonicalOtaReadiness(
    evidence({
      propertyPayload: {
        data: {
          type: "property",
          id: "prop-ext",
          attributes: { id: "prop-ext", acc_channels_count: 99 },
        },
      },
      channelVerification: null,
    })
  );
  assert.equal(result.authorizationReadiness, "IN_PROGRESS");
  assert.equal(result.distributionReadiness, "IN_PROGRESS");
  assert.ok(result.reasons.includes("CHANNEL_IDENTITY_NOT_VERIFIED"));
});

test("property inventory alone never proves channel mapping", () => {
  const result = deriveCanonicalOtaReadiness(
    evidence({ channelVerification: verification({ mappingVerified: false }) })
  );
  assert.equal(result.mappingReadiness, "IN_PROGRESS");
  assert.ok(result.reasons.includes("CHANNEL_MAPPING_NOT_VERIFIED"));
});

test("known inactive exact channel blocks distribution", () => {
  const result = deriveCanonicalOtaReadiness(
    evidence({
      channelVerification: verification({
        activeState: false,
        connectedEvidenceVerified: false,
      }),
    })
  );
  assert.equal(result.authorizationReadiness, "READY");
  assert.equal(result.mappingReadiness, "READY");
  assert.equal(result.distributionReadiness, "BLOCKED");
  assert.ok(result.reasons.includes("CHANNEL_NOT_ACTIVE"));
});

test("updated_channel is neutral after a recorded activation", () => {
  const result = deriveCanonicalOtaReadiness(
    evidence({ latestLifecycleEvent: "updated_channel" })
  );
  assert.equal(result.distributionReadiness, "READY");
});

test("active Channex state without lifecycle activation stays in progress", () => {
  const result = deriveCanonicalOtaReadiness(
    evidence({ lastChannelActivatedAt: null })
  );
  assert.equal(result.distributionReadiness, "IN_PROGRESS");
  assert.ok(result.reasons.includes("CHANNEL_ACTIVATION_NOT_OBSERVED"));
});

test("deactivate event remains fail-closed despite a stale active GET", () => {
  const result = deriveCanonicalOtaReadiness(
    evidence({ latestLifecycleEvent: "deactivate_channel" })
  );
  assert.equal(result.distributionReadiness, "BLOCKED");
  assert.ok(result.reasons.includes("CHANNEL_DEACTIVATED"));
});

test("disconnect listing blocks mapping and distribution", () => {
  const result = deriveCanonicalOtaReadiness(
    evidence({ latestLifecycleEvent: "disconnect_listing" })
  );
  assert.equal(result.mappingReadiness, "BLOCKED");
  assert.equal(result.distributionReadiness, "BLOCKED");
});

test("disconnect channel resets authorization and blocks downstream readiness", () => {
  const result = deriveCanonicalOtaReadiness(
    evidence({ latestLifecycleEvent: "disconnect_channel" })
  );
  assert.equal(result.authorizationReadiness, "REQUIRED");
  assert.equal(result.mappingReadiness, "BLOCKED");
  assert.equal(result.distributionReadiness, "BLOCKED");
});

test("ambiguous discovery remains explicitly unbound", () => {
  const result = deriveCanonicalOtaReadiness(
    evidence({
      channelVerification: null,
      channelResolutionReason: "CHANNEL_DISCOVERY_AMBIGUOUS",
    })
  );
  assert.ok(result.reasons.includes("CHANNEL_DISCOVERY_AMBIGUOUS"));
  assert.equal(result.authorizationReadiness, "IN_PROGRESS");
});

test("an inactive channel without durable authorization evidence is not authorized", () => {
  const result = deriveCanonicalOtaReadiness(
    evidence({
      channelVerification: verification({
        activeState: false,
        connectedEvidenceVerified: false,
      }),
      channelAuthorizationVerifiedAt: null,
      lastChannelActivatedAt: null,
    })
  );
  assert.equal(result.authorizationReadiness, "IN_PROGRESS");
  assert.equal(result.distributionReadiness, "BLOCKED");
  assert.ok(result.reasons.includes("CHANNEL_AUTHORIZATION_NOT_VERIFIED"));
});

test("enabled resource without verified connected evidence cannot close distribution", () => {
  const result = deriveCanonicalOtaReadiness(
    evidence({
      channelVerification: verification({
        activeState: true,
        connectedEvidenceVerified: false,
        reasons: ["NO_CONNECTED_CHANNEL_EVIDENCE"],
      }),
    })
  );
  assert.equal(result.authorizationReadiness, "READY");
  assert.equal(result.mappingReadiness, "READY");
  assert.equal(result.distributionReadiness, "IN_PROGRESS");
  assert.ok(result.reasons.includes("NO_CONNECTED_CHANNEL_EVIDENCE"));
});

test("enabled resource cannot infer authorization without connected or durable evidence", () => {
  const result = deriveCanonicalOtaReadiness(
    evidence({
      channelVerification: verification({
        activeState: true,
        connectedEvidenceVerified: false,
        reasons: ["NO_CONNECTED_CHANNEL_EVIDENCE"],
      }),
      channelAuthorizationVerifiedAt: null,
      lastChannelActivatedAt: null,
    })
  );
  assert.equal(result.authorizationReadiness, "IN_PROGRESS");
  assert.equal(result.distributionReadiness, "IN_PROGRESS");
  assert.ok(result.reasons.includes("CHANNEL_AUTHORIZATION_NOT_VERIFIED"));
});

test("remote JSON identifiers must be strings, never coercible arrays", () => {
  for (const override of [
    { propertyPayload: { data: { type: "property", id: ["prop-ext"], attributes: { id: "prop-ext" } } } },
    { roomTypePayload: { data: { type: "room_type", id: "room-ext", attributes: { id: ["room-ext"] }, relationships: { property: { data: { type: "property", id: "prop-ext" } } } } } },
    { ratePlanPayload: { data: { type: "rate_plan", id: "rate-ext", attributes: { id: "rate-ext" }, relationships: { property: { data: { type: "property", id: ["prop-ext"] } }, room_type: { data: { type: "room_type", id: "room-ext" } } } } } },
  ]) {
    const result = deriveCanonicalOtaReadiness(evidence(override));
    assert.notEqual(result.distributionReadiness, "READY");
  }
});
