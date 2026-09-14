import type { ChannexAriCanonicalMappingResult } from "./channex-airbnb-transport-readiness.policy.js";
import type { OtaReadinessStatus } from "./ota-commercial-lifecycle.policy.js";

export const CHANNEX_EXPEDIA_TRANSPORT_POLICY_VERSION =
  "channex_expedia_transport_v1" as const;

export const CHANNEX_EXPEDIA_TRANSPORT_SEMANTIC_SCOPE =
  "TECHNICAL_CHANNEL_CONNECTION" as const;

export const CHANNEX_EXPEDIA_TRANSPORT_DOES_NOT_ATTEST = [
  "EXPEDIA_PAYMENT_CONFIGURATION",
  "EXPEDIA_TAX_CONFIGURATION",
  "EXPEDIA_LISTING_CONTENT",
  "EXPEDIA_ARI_DOWNSTREAM_ACCEPTANCE",
] as const;

export type ChannexExpediaTransportReadinessReason =
  | "POLICY_APPLIED"
  | "PROVIDER_NOT_SUPPORTED"
  | "CHANNEL_IDENTITY_NOT_VERIFIED"
  | "CANONICAL_MAPPING_NOT_VERIFIED"
  | "CHANNEL_NOT_ACTIVE";

export type ChannexExpediaTransportReadinessResult = {
  applied: boolean;
  reason: ChannexExpediaTransportReadinessReason;
  readiness: {
    paymentReadiness: OtaReadinessStatus;
    taxReadiness: OtaReadinessStatus;
    contentReadiness: OtaReadinessStatus;
  };
  metadata: {
    policyVersion: typeof CHANNEX_EXPEDIA_TRANSPORT_POLICY_VERSION;
    semanticScope: typeof CHANNEX_EXPEDIA_TRANSPORT_SEMANTIC_SCOPE;
    doesNotAttest: typeof CHANNEX_EXPEDIA_TRANSPORT_DOES_NOT_ATTEST;
    otaAcceptanceVerified: false;
  };
};

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function expediaPolicyResult(
  applied: boolean,
  reason: ChannexExpediaTransportReadinessReason,
  readiness: ChannexExpediaTransportReadinessResult["readiness"],
): ChannexExpediaTransportReadinessResult {
  return {
    applied,
    reason,
    readiness: { ...readiness },
    metadata: {
      policyVersion: CHANNEX_EXPEDIA_TRANSPORT_POLICY_VERSION,
      semanticScope: CHANNEX_EXPEDIA_TRANSPORT_SEMANTIC_SCOPE,
      doesNotAttest: [...CHANNEX_EXPEDIA_TRANSPORT_DOES_NOT_ATTEST],
      otaAcceptanceVerified: false,
    },
  };
}

/**
 * Technical readiness for Expedia through Channex.
 *
 * This policy proves only the exact Channex channel identity, the canonical
 * Pin&Go-to-Channex mapping and Channex's active channel gate. Expedia payment,
 * tax, listing-content and downstream ARI acceptance remain independent
 * commercial evidence and are preserved unchanged.
 */
export function deriveChannexExpediaTransportReadiness(input: {
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
}): ChannexExpediaTransportReadinessResult {
  if (normalizedText(input.provider) !== "EXPEDIA") {
    return expediaPolicyResult(
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
    expectedChannelCode !== "EXP" ||
    observedConnectionId !== expectedConnectionId ||
    observedChannelCode !== "EXP"
  ) {
    return expediaPolicyResult(
      false,
      "CHANNEL_IDENTITY_NOT_VERIFIED",
      input.currentCommercialReadiness,
    );
  }

  if (input.mapping.verified !== true || input.mapping.reason !== "VERIFIED") {
    return expediaPolicyResult(
      false,
      "CANONICAL_MAPPING_NOT_VERIFIED",
      input.currentCommercialReadiness,
    );
  }

  if (input.observedChannel?.isActive !== true) {
    return expediaPolicyResult(
      false,
      "CHANNEL_NOT_ACTIVE",
      input.currentCommercialReadiness,
    );
  }

  return expediaPolicyResult(
    true,
    "POLICY_APPLIED",
    input.currentCommercialReadiness,
  );
}
