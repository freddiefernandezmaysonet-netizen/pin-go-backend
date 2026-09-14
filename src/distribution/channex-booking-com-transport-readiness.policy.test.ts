import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEX_BOOKING_COM_TRANSPORT_DOES_NOT_ATTEST,
  CHANNEX_BOOKING_COM_TRANSPORT_POLICY_VERSION,
  CHANNEX_BOOKING_COM_TRANSPORT_SEMANTIC_SCOPE,
  deriveChannexBookingComTransportReadiness,
} from "./channex-booking-com-transport-readiness.policy.js";

function bookingComPolicyInput(overrides: Record<string, unknown> = {}) {
  return {
    provider: "BOOKING_COM",
    expectedExternalConnectionId: "booking-com-channel-1",
    expectedExternalChannelCode: "BDC",
    observedChannel: {
      id: "booking-com-channel-1",
      channelCode: "BDC",
      isActive: true,
    },
    mapping: { verified: true, reason: "VERIFIED" },
    currentCommercialReadiness: {
      paymentReadiness: "IN_PROGRESS",
      taxReadiness: "READY",
      contentReadiness: "BLOCKED",
    },
    ...overrides,
  } as Parameters<typeof deriveChannexBookingComTransportReadiness>[0];
}

test("applies Booking.com technical readiness without changing commercial readiness", () => {
  const result = deriveChannexBookingComTransportReadiness(
    bookingComPolicyInput(),
  );

  assert.equal(result.applied, true);
  assert.equal(result.reason, "POLICY_APPLIED");
  assert.deepEqual(result.readiness, {
    paymentReadiness: "IN_PROGRESS",
    taxReadiness: "READY",
    contentReadiness: "BLOCKED",
  });
  assert.deepEqual(result.metadata, {
    policyVersion: CHANNEX_BOOKING_COM_TRANSPORT_POLICY_VERSION,
    semanticScope: CHANNEX_BOOKING_COM_TRANSPORT_SEMANTIC_SCOPE,
    doesNotAttest: [...CHANNEX_BOOKING_COM_TRANSPORT_DOES_NOT_ATTEST],
    otaAcceptanceVerified: false,
  });
});

test("requires exact Booking.com provider, BDC identity, canonical mapping and active channel", () => {
  const cases = [
    [
      bookingComPolicyInput({ provider: "AIRBNB" }),
      "PROVIDER_NOT_SUPPORTED",
    ],
    [
      bookingComPolicyInput({ expectedExternalChannelCode: "ABB" }),
      "CHANNEL_IDENTITY_NOT_VERIFIED",
    ],
    [
      bookingComPolicyInput({
        observedChannel: {
          id: "other-channel",
          channelCode: "BDC",
          isActive: true,
        },
      }),
      "CHANNEL_IDENTITY_NOT_VERIFIED",
    ],
    [
      bookingComPolicyInput({
        mapping: {
          verified: false,
          reason: "EXTERNAL_RATE_PLAN_ID_MISMATCH",
        },
      }),
      "CANONICAL_MAPPING_NOT_VERIFIED",
    ],
    [
      bookingComPolicyInput({
        observedChannel: {
          id: "booking-com-channel-1",
          channelCode: "BDC",
          isActive: false,
        },
      }),
      "CHANNEL_NOT_ACTIVE",
    ],
  ] as const;

  for (const [input, reason] of cases) {
    const result = deriveChannexBookingComTransportReadiness(input);
    assert.equal(result.applied, false);
    assert.equal(result.reason, reason);
    assert.deepEqual(result.readiness, input.currentCommercialReadiness);
  }
});

test("does not mutate the caller's commercial-readiness object", () => {
  const input = bookingComPolicyInput();
  const result = deriveChannexBookingComTransportReadiness(input);

  assert.notEqual(result.readiness, input.currentCommercialReadiness);
  assert.deepEqual(result.readiness, input.currentCommercialReadiness);
});
