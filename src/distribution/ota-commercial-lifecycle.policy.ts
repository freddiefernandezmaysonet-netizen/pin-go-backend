export const OTA_CHANNEL_CONNECTION_STATUSES = [
  "NOT_CONNECTED",
  "AUTHORIZATION_REQUIRED",
  "MAPPING_REQUIRED",
  "READINESS_CHECK",
  "ACTIVATION_PENDING",
  "ACTIVE",
  "DEGRADED",
  "FAILED",
  "DISCONNECTING",
  "DISCONNECTED",
] as const;

export type OtaChannelConnectionStatus =
  (typeof OTA_CHANNEL_CONNECTION_STATUSES)[number];

export const OTA_READINESS_STATUSES = [
  "NOT_STARTED",
  "REQUIRED",
  "IN_PROGRESS",
  "READY",
  "BLOCKED",
  "NOT_APPLICABLE",
] as const;

export type OtaReadinessStatus = (typeof OTA_READINESS_STATUSES)[number];

export type OtaActivationEvidence = {
  distributionPropertyStatus: "NOT_PROVISIONED" | "PROVISIONING" | "READY" | "FAILED";
  externalConnectionId: string | null;
  authorizationReadiness: OtaReadinessStatus;
  mappingReadiness: OtaReadinessStatus;
  distributionReadiness: OtaReadinessStatus;
  paymentReadiness: OtaReadinessStatus;
  taxReadiness: OtaReadinessStatus;
  contentReadiness: OtaReadinessStatus;
  lastFullSyncConfirmedAt: Date | null;
};

export type OtaActivationBlocker =
  | "DISTRIBUTION_PROPERTY_NOT_READY"
  | "EXTERNAL_CONNECTION_ID_MISSING"
  | "AUTHORIZATION_NOT_READY"
  | "MAPPING_NOT_READY"
  | "DISTRIBUTION_NOT_READY"
  | "PAYMENT_NOT_READY"
  | "TAX_NOT_READY"
  | "CONTENT_NOT_READY"
  | "FULL_SYNC_NOT_CONFIRMED";

const OPTIONAL_READINESS_COMPLETE = new Set<OtaReadinessStatus>([
  "READY",
  "NOT_APPLICABLE",
]);

const ALLOWED_TRANSITIONS: Record<
  OtaChannelConnectionStatus,
  ReadonlySet<OtaChannelConnectionStatus>
> = {
  NOT_CONNECTED: new Set(["AUTHORIZATION_REQUIRED"]),
  AUTHORIZATION_REQUIRED: new Set(["MAPPING_REQUIRED", "FAILED", "DISCONNECTED"]),
  MAPPING_REQUIRED: new Set(["READINESS_CHECK", "FAILED", "DISCONNECTED"]),
  READINESS_CHECK: new Set([
    "MAPPING_REQUIRED",
    "ACTIVATION_PENDING",
    "FAILED",
    "DISCONNECTED",
  ]),
  ACTIVATION_PENDING: new Set(["ACTIVE", "FAILED", "DISCONNECTED"]),
  ACTIVE: new Set(["DEGRADED", "DISCONNECTING"]),
  DEGRADED: new Set(["READINESS_CHECK", "ACTIVE", "FAILED", "DISCONNECTING"]),
  FAILED: new Set([
    "AUTHORIZATION_REQUIRED",
    "MAPPING_REQUIRED",
    "READINESS_CHECK",
    "DISCONNECTED",
  ]),
  DISCONNECTING: new Set(["DISCONNECTED", "FAILED"]),
  DISCONNECTED: new Set(["AUTHORIZATION_REQUIRED"]),
};

export function assessOtaActivationReadiness(
  evidence: OtaActivationEvidence
): { canActivate: boolean; blockers: OtaActivationBlocker[] } {
  const blockers: OtaActivationBlocker[] = [];

  if (evidence.distributionPropertyStatus !== "READY") {
    blockers.push("DISTRIBUTION_PROPERTY_NOT_READY");
  }
  if (!String(evidence.externalConnectionId ?? "").trim()) {
    blockers.push("EXTERNAL_CONNECTION_ID_MISSING");
  }
  if (evidence.authorizationReadiness !== "READY") {
    blockers.push("AUTHORIZATION_NOT_READY");
  }
  if (evidence.mappingReadiness !== "READY") {
    blockers.push("MAPPING_NOT_READY");
  }
  if (evidence.distributionReadiness !== "READY") {
    blockers.push("DISTRIBUTION_NOT_READY");
  }
  if (!OPTIONAL_READINESS_COMPLETE.has(evidence.paymentReadiness)) {
    blockers.push("PAYMENT_NOT_READY");
  }
  if (!OPTIONAL_READINESS_COMPLETE.has(evidence.taxReadiness)) {
    blockers.push("TAX_NOT_READY");
  }
  if (!OPTIONAL_READINESS_COMPLETE.has(evidence.contentReadiness)) {
    blockers.push("CONTENT_NOT_READY");
  }
  if (!evidence.lastFullSyncConfirmedAt) {
    blockers.push("FULL_SYNC_NOT_CONFIRMED");
  }

  return { canActivate: blockers.length === 0, blockers };
}

export function assertOtaChannelTransition(args: {
  current: OtaChannelConnectionStatus;
  next: OtaChannelConnectionStatus;
  activationEvidence?: OtaActivationEvidence;
}) {
  if (args.current === args.next) return;

  if (!ALLOWED_TRANSITIONS[args.current].has(args.next)) {
    throw new Error(`OTA_CHANNEL_TRANSITION_INVALID:${args.current}:${args.next}`);
  }

  if (args.next === "ACTIVE") {
    if (!args.activationEvidence) {
      throw new Error("OTA_CHANNEL_ACTIVATION_EVIDENCE_REQUIRED");
    }

    const readiness = assessOtaActivationReadiness(args.activationEvidence);
    if (!readiness.canActivate) {
      throw new Error(
        `OTA_CHANNEL_ACTIVATION_BLOCKED:${readiness.blockers.join(",")}`
      );
    }
  }
}

export function assertDistributionTenantScope(args: {
  organizationId: string;
  propertyOrganizationId: string;
  groupOrganizationId: string;
  distributionPropertyOrganizationId: string;
}) {
  const expected = String(args.organizationId ?? "").trim();
  const observed = [
    args.propertyOrganizationId,
    args.groupOrganizationId,
    args.distributionPropertyOrganizationId,
  ].map((value) => String(value ?? "").trim());

  if (!expected || observed.some((value) => !value || value !== expected)) {
    throw new Error("OTA_DISTRIBUTION_TENANT_MISMATCH");
  }
}

export type PropertyCommercialDistributionStatus =
  | "NOT_CONFIGURED"
  | "SETUP_REQUIRED"
  | "ACTIVATION_PENDING"
  | "ACTIVE"
  | "DEGRADED"
  | "FAILED";

export function derivePropertyCommercialDistributionStatus(
  channels: readonly OtaChannelConnectionStatus[]
): PropertyCommercialDistributionStatus {
  if (channels.length === 0 || channels.every((status) => status === "DISCONNECTED")) {
    return "NOT_CONFIGURED";
  }
  if (channels.some((status) => status === "DEGRADED")) return "DEGRADED";
  if (channels.some((status) => status === "ACTIVE")) return "ACTIVE";
  if (channels.every((status) => status === "FAILED")) return "FAILED";
  if (
    channels.some((status) =>
      ["READINESS_CHECK", "ACTIVATION_PENDING", "DISCONNECTING"].includes(status)
    )
  ) {
    return "ACTIVATION_PENDING";
  }
  return "SETUP_REQUIRED";
}
