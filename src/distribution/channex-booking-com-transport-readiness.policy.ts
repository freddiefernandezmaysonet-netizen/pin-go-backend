import type { ChannexAriCanonicalMappingResult } from "./channex-airbnb-transport-readiness.policy.js";
import type { OtaReadinessStatus } from "./ota-commercial-lifecycle.policy.js";

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

export type ChannexBookingComTransportReadinessResult = {
  applied: boolean;
  reason: ChannexBookingComTransportReadinessReason;
  readiness: {
    paymentReadiness: OtaReadinessStatus;
    taxReadiness: OtaReadinessStatus;
    contentReadiness: OtaReadinessStatus;
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

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bookingComPolicyResult(
  applied: boolean,
  reason: ChannexBookingComTransportReadinessReason,
  readiness: ChannexBookingComTransportReadinessResult["readiness"],
): ChannexBookingComTransportReadinessResult {
  return {
    applied,
    reason,
    readiness: { ...readiness },
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
 * evidence. Their independently persisted readiness is preserved unchanged.
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
  currentCommercialReadiness: {
    paymentReadiness: OtaReadinessStatus;
    taxReadiness: OtaReadinessStatus;
    contentReadiness: OtaReadinessStatus;
  };
}): ChannexBookingComTransportReadinessResult {
  if (normalizedText(input.provider) !== "BOOKING_COM") {
    return bookingComPolicyResult(
      false,
      "PROVIDER_NOT_SUPPORTED",
      input.currentCommercialReadiness,
    );
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
    return bookingComPolicyResult(
      false,
      "CHANNEL_IDENTITY_NOT_VERIFIED",
      input.currentCommercialReadiness,
    );
  }

  if (input.mapping.verified !== true || input.mapping.reason !== "VERIFIED") {
    return bookingComPolicyResult(
      false,
      "CANONICAL_MAPPING_NOT_VERIFIED",
      input.currentCommercialReadiness,
    );
  }

  if (input.observedChannel?.isActive !== true) {
    return bookingComPolicyResult(
      false,
      "CHANNEL_NOT_ACTIVE",
      input.currentCommercialReadiness,
    );
  }

  return bookingComPolicyResult(
    true,
    "POLICY_APPLIED",
    input.currentCommercialReadiness,
  );
}
