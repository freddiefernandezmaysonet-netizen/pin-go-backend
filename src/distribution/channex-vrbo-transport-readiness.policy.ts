import type { ChannexAriCanonicalMappingResult } from "./channex-airbnb-transport-readiness.policy.js";
import type { OtaReadinessStatus } from "./ota-commercial-lifecycle.policy.js";

export const CHANNEX_VRBO_TRANSPORT_POLICY_VERSION =
  "channex_vrbo_transport_v1" as const;

export const CHANNEX_VRBO_TRANSPORT_SEMANTIC_SCOPE =
  "TECHNICAL_CHANNEL_CONNECTION" as const;

export const CHANNEX_VRBO_TRANSPORT_DOES_NOT_ATTEST = [
  "VRBO_PAYMENT_CONFIGURATION",
  "VRBO_TAX_CONFIGURATION",
  "VRBO_LISTING_CONTENT",
  "VRBO_ARI_DOWNSTREAM_ACCEPTANCE",
] as const;

type Reason =
  | "POLICY_APPLIED"
  | "PROVIDER_NOT_SUPPORTED"
  | "CHANNEL_IDENTITY_NOT_VERIFIED"
  | "CANONICAL_MAPPING_NOT_VERIFIED"
  | "CHANNEL_NOT_ACTIVE";

type Readiness = {
  paymentReadiness: OtaReadinessStatus;
  taxReadiness: OtaReadinessStatus;
  contentReadiness: OtaReadinessStatus;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function result(applied: boolean, reason: Reason, readiness: Readiness) {
  return {
    applied,
    reason,
    readiness: { ...readiness },
    metadata: {
      policyVersion: CHANNEX_VRBO_TRANSPORT_POLICY_VERSION,
      semanticScope: CHANNEX_VRBO_TRANSPORT_SEMANTIC_SCOPE,
      doesNotAttest: [...CHANNEX_VRBO_TRANSPORT_DOES_NOT_ATTEST],
      otaAcceptanceVerified: false as const,
    },
  };
}

/** Proves only the exact active Vrbo channel and canonical ARI mapping. */
export function deriveChannexVrboTransportReadiness(input: {
  provider: string;
  expectedExternalConnectionId: string | null;
  expectedExternalChannelCode: string | null;
  observedChannel: { id: string; channelCode: string; isActive: boolean } | null;
  mapping: ChannexAriCanonicalMappingResult;
  currentCommercialReadiness: Readiness;
}) {
  if (text(input.provider) !== "VRBO") {
    return result(false, "PROVIDER_NOT_SUPPORTED", input.currentCommercialReadiness);
  }
  if (
    !text(input.expectedExternalConnectionId) ||
    text(input.expectedExternalChannelCode).toUpperCase() !== "VRB" ||
    text(input.observedChannel?.id) !== text(input.expectedExternalConnectionId) ||
    text(input.observedChannel?.channelCode).toUpperCase() !== "VRB"
  ) {
    return result(false, "CHANNEL_IDENTITY_NOT_VERIFIED", input.currentCommercialReadiness);
  }
  if (input.mapping.verified !== true || input.mapping.reason !== "VERIFIED") {
    return result(false, "CANONICAL_MAPPING_NOT_VERIFIED", input.currentCommercialReadiness);
  }
  if (input.observedChannel?.isActive !== true) {
    return result(false, "CHANNEL_NOT_ACTIVE", input.currentCommercialReadiness);
  }
  return result(true, "POLICY_APPLIED", input.currentCommercialReadiness);
}
