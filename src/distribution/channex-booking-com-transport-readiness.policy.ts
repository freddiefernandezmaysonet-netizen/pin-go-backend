import type { ChannexAriCanonicalMappingResult } from "./channex-airbnb-transport-readiness.policy.js";

export const CHANNEX_BOOKING_COM_TRANSPORT_POLICY_VERSION =
  "channex_booking_com_transport_v1" as const;

export const CHANNEX_BOOKING_COM_TRANSPORT_SEMANTIC_SCOPE =
  "TECHNICAL_CHANNEL_CONNECTION" as const;

export const CHANNEX_BOOKING_COM_TRANSPORT_DOES_NOT_ATTEST = [
  "BOOKING_COM_PAYMENT_CONFIGURATION",
  "BOOKING_COM_TAX_CONFIGURATION",
  "BOOKING_COM_LISTING_CONTENT",
  "BOOKING_COM_ARI_DOWNSTREAM_ACCEPTANCE",
] as const;

export type ChannexBookingComTransportReadinessReason =
  | "POLICY_APPLIED"
  | "PROVIDER_NOT_SUPPORTED"
  | "CHANNEL_IDENTITY_NOT_VERIFIED"
  | "CANONICAL_MAPPING_NOT_VERIFIED"
  | "CHANNEL_NOT_ACTIVE";

type ChannexBookingComTransportReadinessStatus =
  | "NOT_STARTED"
  | "NOT_APPLICABLE";

export type ChannexBookingComTransportReadinessResult = {
  applied: boolean;
  reason: ChannexBookingComTransportReadinessReason;
  readiness: {
    paymentReadiness: ChannexBookingComTransportReadinessStatus;
    taxReadiness: ChannexBookingComTransportReadinessStatus;
    contentReadiness: ChannexBookingComTransportReadinessStatus;
  };
  metadata: {
    policyVersion: typeof CHANNEX_BOOKING_COM_TRANSPORT_POLICY_VERSION;
    semanticScope: typeof CHANNEX_BOOKING_COM_TRANSPORT_SEMANTIC_SCOPE;
    doesNotAttest: readonly [
      "BOOKING_COM_PAYMENT_CONFIGURATION",
      "BOOKING_COM_TAX_CONFIGURATION",
      "BOOKING_COM_LISTING_CONTENT",
      "BOOKING_COM_ARI_DOWNSTREAM_ACCEPTANCE",
    ];
    otaAcceptanceVerified: false;
  };
};

const FAIL_CLOSED_READINESS = {
  paymentReadiness: "NOT_STARTED",
  taxReadiness: "NOT_STARTED",
  contentReadiness: "NOT_STARTED",
} as const;

const NOT_APPLICABLE_READINESS = {
  paymentReadiness: "NOT_APPLICABLE",
  taxReadiness: "NOT_APPLICABLE",
  contentReadiness: "NOT_APPLICABLE",
} as const;

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bookingComPolicyResult(
  applied: boolean,
  reason: ChannexBookingComTransportReadinessReason,
): ChannexBookingComTransportReadinessResult {
  return {
    applied,
    reason,
    readiness: {
      ...(applied ? NOT_APPLICABLE_READINESS : FAIL_CLOSED_READINESS),
    },
    metadata: {
      policyVersion: CHANNEX_BOOKING_COM_TRANSPORT_POLICY_VERSION,
      semanticScope: CHANNEX_BOOKING_COM_TRANSPORT_SEMANTIC_SCOPE,
      doesNotAttest: [...CHANNEX_BOOKING_COM_TRANSPORT_DOES_NOT_ATTEST],
      otaAcceptanceVerified: false,
    },
  };
}

/**
 * Technical readiness for Booking.com through Channex.
 *
 * This policy proves only the exact Channex channel identity, the canonical
 * Pin&Go-to-Channex mapping and Channex's active channel gate. It deliberately
 * does not attest Booking.com payment, tax, listing-content or downstream ARI
 * acceptance. Those concerns must not be fabricated from technical channel
 * evidence, so they become NOT_APPLICABLE only after the technical boundary is
 * proven.
 */
export function deriveChannexBookingComTransportReadiness(input: {
  provider: string;
  expectedExternalConnectionId: string | null;
  expectedExternalChannelCode: string | null;
  observedChannel: {
    id: string;
    channelCode: string;
    isActive: boolean;
  } | null;
  mapping: ChannexAriCanonicalMappingResult;
}): ChannexBookingComTransportReadinessResult {
  if (normalizedText(input.provider) !== "BOOKING_COM") {
    return bookingComPolicyResult(false, "PROVIDER_NOT_SUPPORTED");
  }

  const expectedConnectionId = normalizedText(
    input.expectedExternalConnectionId,
  );
  const expectedChannelCode = normalizedText(
    input.expectedExternalChannelCode,
  ).toUpperCase();
  const observedConnectionId = normalizedText(input.observedChannel?.id);
  const observedChannelCode = normalizedText(
    input.observedChannel?.channelCode,
  ).toUpperCase();

  if (
    !expectedConnectionId ||
    expectedChannelCode !== "BDC" ||
    observedConnectionId !== expectedConnectionId ||
    observedChannelCode !== "BDC"
  ) {
    return bookingComPolicyResult(false, "CHANNEL_IDENTITY_NOT_VERIFIED");
  }

  if (input.mapping.verified !== true || input.mapping.reason !== "VERIFIED") {
    return bookingComPolicyResult(false, "CANONICAL_MAPPING_NOT_VERIFIED");
  }

  if (input.observedChannel?.isActive !== true) {
    return bookingComPolicyResult(false, "CHANNEL_NOT_ACTIVE");
  }

  return bookingComPolicyResult(true, "POLICY_APPLIED");
}
