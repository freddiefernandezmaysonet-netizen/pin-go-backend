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
  fullSyncRequiredAfterAt: Date | null;
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
  | "FULL_SYNC_NOT_CONFIRMED"
  | "FULL_SYNC_EVIDENCE_INVALID"
  | "FULL_SYNC_FRONTIER_MISSING"
  | "FULL_SYNC_FRONTIER_INVALID"
  | "FULL_SYNC_PREDATES_LIFECYCLE";

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
  MAPPING_REQUIRED: new Set([
    "AUTHORIZATION_REQUIRED",
    "READINESS_CHECK",
    "FAILED",
    "DISCONNECTED",
  ]),
  READINESS_CHECK: new Set([
    "AUTHORIZATION_REQUIRED",
    "MAPPING_REQUIRED",
    "ACTIVATION_PENDING",
    "FAILED",
    "DISCONNECTED",
  ]),
  ACTIVATION_PENDING: new Set([
    "AUTHORIZATION_REQUIRED",
    "MAPPING_REQUIRED",
    "READINESS_CHECK",
    "ACTIVE",
    "FAILED",
    "DISCONNECTED",
  ]),
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
  const confirmedAtMs = evidence.lastFullSyncConfirmedAt?.getTime() ?? null;
  const frontierAtMs = evidence.fullSyncRequiredAfterAt?.getTime() ?? null;
  if (!evidence.lastFullSyncConfirmedAt) {
    blockers.push("FULL_SYNC_NOT_CONFIRMED");
  } else if (confirmedAtMs === null || !Number.isFinite(confirmedAtMs)) {
    blockers.push("FULL_SYNC_EVIDENCE_INVALID");
  } else if (!evidence.fullSyncRequiredAfterAt) {
    blockers.push("FULL_SYNC_FRONTIER_MISSING");
  } else if (
    evidence.fullSyncRequiredAfterAt &&
    (frontierAtMs === null || !Number.isFinite(frontierAtMs))
  ) {
    blockers.push("FULL_SYNC_FRONTIER_INVALID");
  } else if (
    frontierAtMs !== null &&
    confirmedAtMs < frontierAtMs
  ) {
    blockers.push("FULL_SYNC_PREDATES_LIFECYCLE");
  }

  return { canActivate: blockers.length === 0, blockers };
}

export function assertOtaChannelTransition(args: {
  current: OtaChannelConnectionStatus;
  next: OtaChannelConnectionStatus;
  activationEvidence?: OtaActivationEvidence;
}) {
  if (args.current === args.next) {
    if (args.next !== "ACTIVE") return;
    if (!args.activationEvidence) {
      throw new Error("OTA_CHANNEL_ACTIVATION_EVIDENCE_REQUIRED");
    }
    const readiness = assessOtaActivationReadiness(args.activationEvidence);
    if (!readiness.canActivate) {
      throw new Error(
        `OTA_CHANNEL_ACTIVATION_BLOCKED:${readiness.blockers.join(",")}`
      );
    }
    return;
  }

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

const ACTIVATION_PATH: readonly OtaChannelConnectionStatus[] = [
  "NOT_CONNECTED",
  "AUTHORIZATION_REQUIRED",
  "MAPPING_REQUIRED",
  "READINESS_CHECK",
  "ACTIVATION_PENDING",
  "ACTIVE",
];

export function planCanonicalOtaActivation(args: {
  current: OtaChannelConnectionStatus;
  evidence: OtaActivationEvidence;
}): {
  next: OtaChannelConnectionStatus;
  path: OtaChannelConnectionStatus[];
  blockers: OtaActivationBlocker[];
} {
  const readiness = assessOtaActivationReadiness(args.evidence);

  if (args.current === "ACTIVE") {
    if (readiness.canActivate) {
      return { next: "ACTIVE", path: [], blockers: [] };
    }
    assertOtaChannelTransition({ current: "ACTIVE", next: "DEGRADED" });
    return {
      next: "DEGRADED",
      path: ["DEGRADED"],
      blockers: readiness.blockers,
    };
  }

  if (args.current === "DEGRADED") {
    if (!readiness.canActivate) {
      return { next: "DEGRADED", path: [], blockers: readiness.blockers };
    }
    assertOtaChannelTransition({
      current: "DEGRADED",
      next: "ACTIVE",
      activationEvidence: args.evidence,
    });
    return { next: "ACTIVE", path: ["ACTIVE"], blockers: [] };
  }

  // A disconnected channel is reopened only by a fresh new_channel lifecycle
  // event, which moves it to AUTHORIZATION_REQUIRED before reconciliation.
  // Read-only evidence for the previously disconnected channel is insufficient.
  if (args.current === "DISCONNECTED" || args.current === "DISCONNECTING") {
    return { next: args.current, path: [], blockers: readiness.blockers };
  }

  const hasExternalConnectionId = Boolean(
    String(args.evidence.externalConnectionId ?? "").trim()
  );

  const currentIndex = ACTIVATION_PATH.indexOf(args.current);
  if (currentIndex < 0 && args.current !== "FAILED") {
    return { next: args.current, path: [], blockers: readiness.blockers };
  }

  let targetIndex = hasExternalConnectionId ? 1 : 0;
  if (
    hasExternalConnectionId &&
    args.evidence.authorizationReadiness === "READY"
  ) {
    targetIndex = 2;
  }
  if (
    args.evidence.authorizationReadiness === "READY" &&
    args.evidence.mappingReadiness === "READY"
  ) {
    targetIndex = 3;
  }
  if (
    args.evidence.authorizationReadiness === "READY" &&
    args.evidence.mappingReadiness === "READY" &&
    args.evidence.distributionReadiness === "READY"
  ) {
    targetIndex = 4;
  }
  if (readiness.canActivate) targetIndex = 5;

  if (args.current === "FAILED") {
    if (!hasExternalConnectionId) {
      return { next: "FAILED", path: [], blockers: readiness.blockers };
    }
    const recoveryIndex = Math.min(targetIndex, 3);
    const recoveryStatus = ACTIVATION_PATH[recoveryIndex]!;
    assertOtaChannelTransition({ current: "FAILED", next: recoveryStatus });
    const path: OtaChannelConnectionStatus[] = [recoveryStatus];
    let current = recoveryStatus;
    for (const next of ACTIVATION_PATH.slice(recoveryIndex + 1, targetIndex + 1)) {
      assertOtaChannelTransition({
        current,
        next,
        ...(next === "ACTIVE" ? { activationEvidence: args.evidence } : {}),
      });
      path.push(next);
      current = next;
    }
    return { next: current, path, blockers: readiness.blockers };
  }

  if (targetIndex === currentIndex) {
    return { next: args.current, path: [], blockers: readiness.blockers };
  }

  if (targetIndex < currentIndex) {
    const target = ACTIVATION_PATH[targetIndex]!;
    if (target === "NOT_CONNECTED") {
      assertOtaChannelTransition({ current: args.current, next: "FAILED" });
      return {
        next: "FAILED",
        path: ["FAILED"],
        blockers: readiness.blockers,
      };
    }
    assertOtaChannelTransition({ current: args.current, next: target });
    return { next: target, path: [target], blockers: readiness.blockers };
  }

  const path = ACTIVATION_PATH.slice(currentIndex + 1, targetIndex + 1);
  let current: OtaChannelConnectionStatus = args.current;
  for (const next of path) {
    assertOtaChannelTransition({
      current,
      next,
      ...(next === "ACTIVE" ? { activationEvidence: args.evidence } : {}),
    });
    current = next;
  }
  return { next: current, path: [...path], blockers: readiness.blockers };
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
  if (channels.some((status) => status === "ACTIVE")) {
    if (
      channels.some((status) =>
        ["FAILED", "DISCONNECTING"].includes(status)
      )
    ) {
      return "DEGRADED";
    }
    return "ACTIVE";
  }
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
