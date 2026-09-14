import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEX_EXPEDIA_TRANSPORT_DOES_NOT_ATTEST,
  CHANNEX_EXPEDIA_TRANSPORT_POLICY_VERSION,
  CHANNEX_EXPEDIA_TRANSPORT_SEMANTIC_SCOPE,
  deriveChannexExpediaTransportReadiness,
} from "./channex-expedia-transport-readiness.policy.js";

function expediaPolicyInput(overrides: Record<string, unknown> = {}) {
  return {
    provider: "EXPEDIA",
    expectedExternalConnectionId: "expedia-channel-1",
    expectedExternalChannelCode: "EXP",
    observedChannel: {
      id: "expedia-channel-1",
      channelCode: "EXP",
      isActive: true,
    },
    mapping: { verified: true, reason: "VERIFIED" },
    currentCommercialReadiness: {
      paymentReadiness: "IN_PROGRESS",
      taxReadiness: "READY",
      contentReadiness: "BLOCKED",
    },
    ...overrides,
  } as Parameters<typeof deriveChannexExpediaTransportReadiness>[0];
}

test("applies Expedia technical readiness without changing commercial readiness", () => {
  const result = deriveChannexExpediaTransportReadiness(expediaPolicyInput());

  assert.equal(result.applied, true);
  assert.equal(result.reason, "POLICY_APPLIED");
  assert.deepEqual(result.readiness, {
    paymentReadiness: "IN_PROGRESS",
    taxReadiness: "READY",
    contentReadiness: "BLOCKED",
  });
  assert.deepEqual(result.metadata, {
    policyVersion: CHANNEX_EXPEDIA_TRANSPORT_POLICY_VERSION,
    semanticScope: CHANNEX_EXPEDIA_TRANSPORT_SEMANTIC_SCOPE,
    doesNotAttest: [...CHANNEX_EXPEDIA_TRANSPORT_DOES_NOT_ATTEST],
    otaAcceptanceVerified: false,
  });
});

test("requires exact Expedia provider, EXP identity, canonical mapping and active channel", () => {
  const cases = [
    [expediaPolicyInput({ provider: "BOOKING_COM" }), "PROVIDER_NOT_SUPPORTED"],
    [
      expediaPolicyInput({ expectedExternalChannelCode: "BDC" }),
      "CHANNEL_IDENTITY_NOT_VERIFIED",
    ],
    [
      expediaPolicyInput({
        observedChannel: {
          id: "other-channel",
          channelCode: "EXP",
          isActive: true,
        },
      }),
      "CHANNEL_IDENTITY_NOT_VERIFIED",
    ],
    [
      expediaPolicyInput({
        mapping: {
          verified: false,
          reason: "EXTERNAL_RATE_PLAN_ID_MISMATCH",
        },
      }),
      "CANONICAL_MAPPING_NOT_VERIFIED",
    ],
    [
      expediaPolicyInput({
        observedChannel: {
          id: "expedia-channel-1",
          channelCode: "EXP",
          isActive: false,
        },
      }),
      "CHANNEL_NOT_ACTIVE",
    ],
  ] as const;

  for (const [input, reason] of cases) {
    const result = deriveChannexExpediaTransportReadiness(input);
    assert.equal(result.applied, false);
    assert.equal(result.reason, reason);
    assert.deepEqual(result.readiness, input.currentCommercialReadiness);
  }
});

test("does not mutate the caller's commercial-readiness object", () => {
  const input = expediaPolicyInput();
  const result = deriveChannexExpediaTransportReadiness(input);

  assert.notEqual(result.readiness, input.currentCommercialReadiness);
  assert.deepEqual(result.readiness, input.currentCommercialReadiness);
});
