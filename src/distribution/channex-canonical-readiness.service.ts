import { createHash } from "node:crypto";

import type { ConnectionCenterProvider } from "./connection-center.read-model.js";
import {
  ChannexReadonlyTransportError,
  type ChannexReadonlyTransport,
} from "./channex-readonly.http-transport.js";
import {
  ChannexChannelIdentityError,
  discoverUniqueChannexChannel,
  verifyExactChannexChannel,
  type ChannexChannelDiscoveryResult,
  type ChannexChannelVerification,
} from "./channex-channel-identity.js";
import {
  deriveCanonicalOtaReadiness,
  type CanonicalLifecycleEvent,
  type CanonicalOtaReadinessResult,
} from "./channex-canonical-readiness.reconciler.js";
import {
  deriveChannexAirbnbTransportReadiness,
  qualifyChannexCorrelatedFullSyncEvidence,
  validateChannexAriCanonicalMapping,
  type ChannexCorrelatedFullSyncOutboxEvidence,
} from "./channex-airbnb-transport-readiness.policy.js";
import {
  planCanonicalOtaActivation,
  type OtaChannelConnectionStatus,
  type OtaReadinessStatus,
} from "./ota-commercial-lifecycle.policy.js";

const LIFECYCLE_PRECEDENCE: Readonly<Record<CanonicalLifecycleEvent, number>> = {
  new_channel: 10,
  updated_channel: 20,
  activate_channel: 30,
  deactivate_channel: 40,
  disconnect_listing: 50,
  disconnect_channel: 60,
};

export class CanonicalOtaReadinessServiceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CanonicalOtaReadinessServiceError";
  }
}

type DistributionPropertyRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  groupId: string | null;
  platform: string;
  externalPropertyId: string | null;
  externalPrimaryRoomTypeId: string | null;
  externalPrimaryRatePlanId: string | null;
  provisioningStatus: "NOT_PROVISIONED" | "PROVISIONING" | "READY" | "FAILED";
  updatedAt: Date;
  property: {
    id: string;
    organizationId: string;
  } | null;
  group: {
    id: string;
    organizationId: string;
    platform: string;
    externalGroupId: string | null;
    provisioningStatus: "NOT_PROVISIONED" | "PROVISIONING" | "READY" | "FAILED";
    updatedAt: Date;
  } | null;
};

type ConnectionRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  distributionPropertyId: string;
  provider: ConnectionCenterProvider;
  externalConnectionId: string | null;
  externalChannelCode: string | null;
  externalListingId: string | null;
  status: OtaChannelConnectionStatus;
  paymentReadiness: OtaReadinessStatus;
  taxReadiness: OtaReadinessStatus;
  contentReadiness: OtaReadinessStatus;
  activationRequestedAt: Date | null;
  activatedAt: Date | null;
  lastFullSyncConfirmedAt: Date | null;
  lastLifecycleOccurredAt: Date | null;
  // Optional only to keep the local pre-generate Prisma client structurally
  // assignable. A missing value is rejected by lifecycleWatermark at runtime.
  lastLifecycleOccurredAtMicros?: bigint | null;
  lastLifecycleEventType: string | null;
  lastLifecycleEventPrecedence: number | null;
  channelAuthorizationVerifiedAt?: Date | null;
  lastChannelActivatedAt: Date | null;
  readinessRevision?: number;
  updatedAt: Date;
};

type ChannexPropertyStateRecord = {
  organizationId: string;
  propertyId: string;
  lastFullSyncRequestedAt: Date | null;
  lastFullSyncCompletedAt: Date | null;
  updatedAt: Date;
};

type PmsListingRecord = {
  id: string;
  connectionId: string;
  propertyId: string | null;
  externalListingId: string;
  metadata: unknown;
  updatedAt: Date;
  connection: {
    id: string;
    organizationId: string;
    provider: string;
    status: string;
    updatedAt: Date;
  };
};

type CanonicalReadinessAuditRecord = {
  id: string;
  organizationId: string | null;
  propertyId: string | null;
  entityType: string;
  entityId: string;
  engine: string;
  eventType: string | null;
  status: string;
  metadata?: unknown;
};

type CanonicalReadinessTransaction = {
  distributionProperty: {
    findFirst(args: any): Promise<DistributionPropertyRecord | null>;
  };
  otaChannelConnection: {
    findFirst(args: any): Promise<{
      id: string;
      organizationId: string;
      propertyId: string;
      readinessRevision?: number;
    } | null>;
    updateMany(args: any): Promise<{ count: number }>;
  };
  channexAriPropertyState?: {
    findUnique(args: any): Promise<ChannexPropertyStateRecord | null>;
  };
  pmsListing: {
    findMany(args: any): Promise<PmsListingRecord[]>;
  };
  distributionOutboxEvent: {
    findMany(args: any): Promise<ChannexCorrelatedFullSyncOutboxEvidence[]>;
  };
  apmsAuditEntry: {
    findUnique(args: any): Promise<CanonicalReadinessAuditRecord | null>;
    create(args: any): Promise<unknown>;
  };
};

export type CanonicalOtaReadinessClient = {
  distributionProperty: {
    findFirst(args: any): Promise<DistributionPropertyRecord | null>;
  };
  otaChannelConnection: {
    findFirst(args: any): Promise<ConnectionRecord | null>;
  };
  channexAriPropertyState?: {
    findUnique(args: any): Promise<ChannexPropertyStateRecord | null>;
  };
  pmsListing: {
    findMany(args: any): Promise<PmsListingRecord[]>;
  };
  distributionOutboxEvent: {
    findMany(args: any): Promise<ChannexCorrelatedFullSyncOutboxEvidence[]>;
  };
  apmsAuditEntry: {
    findUnique(args: any): Promise<CanonicalReadinessAuditRecord | null>;
  };
  $transaction<T>(
    work: (tx: CanonicalReadinessTransaction) => Promise<T>,
    options?: { isolationLevel?: "Serializable" }
  ): Promise<T>;
};

type ResolvedChannelEvidence = {
  discovery: ChannexChannelDiscoveryResult | null;
  resolutionReason:
    | "CHANNEL_DISCOVERY_NOT_FOUND"
    | "CHANNEL_DISCOVERY_AMBIGUOUS"
    | "CHANNEL_DISCOVERY_STORED_ID_MISMATCH"
    | "CHANNEL_EXACT_NOT_FOUND"
    | "CHANNEL_COLLECTION_CONTRACT_INVALID"
    | "CHANNEL_RESOURCE_CONTRACT_INVALID"
    | null;
  channelId: string | null;
  canonicalChannelCode: string | null;
  verification: ChannexChannelVerification | null;
};

function requiredExternalId(value: string | null, code: string): string {
  const result = String(value ?? "").trim();
  if (!result) throw new CanonicalOtaReadinessServiceError(code);
  return result;
}

const CHANNEX_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredDistributionGroup(
  distributionProperty: DistributionPropertyRecord
): { externalGroupId: string; updatedAt: Date } {
  const group = distributionProperty.group;
  if (
    !group ||
    !distributionProperty.groupId ||
    group.id !== distributionProperty.groupId ||
    group.organizationId !== distributionProperty.organizationId ||
    group.platform !== "CHANNEX" ||
    group.provisioningStatus !== "READY" ||
    !CHANNEX_UUID.test(String(group.externalGroupId ?? "").trim()) ||
    !(group.updatedAt instanceof Date) ||
    !Number.isFinite(group.updatedAt.getTime())
  ) {
    throw new CanonicalOtaReadinessServiceError(
      "OTA_CANONICAL_DISTRIBUTION_GROUP_INVALID"
    );
  }
  return {
    externalGroupId: String(group.externalGroupId).trim(),
    updatedAt: new Date(group.updatedAt),
  };
}

function canonicalChannelCode(
  provider: ConnectionCenterProvider
): string | null {
  if (provider === "AIRBNB") return "ABB";
  if (provider === "BOOKING_COM") return "BDC";
  return null;
}

function documentedChannexAdapterCode(
  provider: ConnectionCenterProvider
): string {
  if (provider === "AIRBNB") return "AirBNB";
  if (provider === "BOOKING_COM") return "BookingCom";
  if (provider === "EXPEDIA") return "Expedia";
  return "Vrbo";
}

function lifecycleWatermark(connection: ConnectionRecord): {
  event: CanonicalLifecycleEvent | null;
  occurredAt: Date | null;
  occurredAtMicros: bigint | null;
  precedence: number | null;
} {
  const values = [
    connection.lastLifecycleOccurredAt,
    connection.lastLifecycleOccurredAtMicros,
    connection.lastLifecycleEventType,
    connection.lastLifecycleEventPrecedence,
  ];
  if (values.every((value) => value === null)) {
    if (
      connection.channelAuthorizationVerifiedAt != null ||
      connection.lastChannelActivatedAt != null
    ) {
      throw new CanonicalOtaReadinessServiceError(
        "OTA_CANONICAL_LIFECYCLE_WATERMARK_INVALID"
      );
    }
    return {
      event: null,
      occurredAt: null,
      occurredAtMicros: null,
      precedence: null,
    };
  }
  if (values.some((value) => value === null)) {
    throw new CanonicalOtaReadinessServiceError(
      "OTA_CANONICAL_LIFECYCLE_WATERMARK_INVALID"
    );
  }

  const event = connection.lastLifecycleEventType as CanonicalLifecycleEvent;
  const occurredAt = new Date(connection.lastLifecycleOccurredAt as Date);
  let occurredAtMicros: bigint;
  try {
    occurredAtMicros = BigInt(connection.lastLifecycleOccurredAtMicros!);
  } catch {
    throw new CanonicalOtaReadinessServiceError(
      "OTA_CANONICAL_LIFECYCLE_WATERMARK_INVALID"
    );
  }
  if (
    !(event in LIFECYCLE_PRECEDENCE) ||
    Number.isNaN(occurredAt.getTime()) ||
    occurredAt.getTime() < 0 ||
    occurredAtMicros < 0n ||
    occurredAtMicros / 1000n !== BigInt(occurredAt.getTime()) ||
    connection.lastLifecycleEventPrecedence !== LIFECYCLE_PRECEDENCE[event]
  ) {
    throw new CanonicalOtaReadinessServiceError(
      "OTA_CANONICAL_LIFECYCLE_WATERMARK_INVALID"
    );
  }
  if (
    connection.lastChannelActivatedAt != null &&
    connection.channelAuthorizationVerifiedAt == null
  ) {
    throw new CanonicalOtaReadinessServiceError(
      "OTA_CANONICAL_LIFECYCLE_WATERMARK_INVALID"
    );
  }
  for (const auxiliaryInstant of [
    connection.channelAuthorizationVerifiedAt,
    connection.lastChannelActivatedAt,
  ]) {
    if (auxiliaryInstant == null) continue;
    if (
      !(auxiliaryInstant instanceof Date) ||
      !Number.isFinite(auxiliaryInstant.getTime()) ||
      auxiliaryInstant.getTime() > occurredAt.getTime()
    ) {
      throw new CanonicalOtaReadinessServiceError(
        "OTA_CANONICAL_LIFECYCLE_WATERMARK_INVALID"
      );
    }
  }
  return {
    event,
    occurredAt,
    occurredAtMicros,
    precedence: connection.lastLifecycleEventPrecedence,
  };
}

function validatedReadinessRevision(revision: unknown): number {
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
    throw new CanonicalOtaReadinessServiceError(
      "OTA_CANONICAL_READINESS_REVISION_INVALID"
    );
  }
  return revision as number;
}

function readinessRevision(connection: ConnectionRecord): number {
  return validatedReadinessRevision(connection.readinessRevision);
}

function readinessDecisionId(args: {
  connectionId: string;
  requestedByUserId: string;
  requestKey: string;
}): string {
  const requestedByUserId = String(args.requestedByUserId ?? "").trim();
  if (!requestedByUserId) {
    throw new CanonicalOtaReadinessServiceError(
      "OTA_CANONICAL_REQUESTED_BY_USER_ID_REQUIRED"
    );
  }
  const requestKey = String(args.requestKey ?? "").trim();
  if (!requestKey) {
    throw new CanonicalOtaReadinessServiceError(
      "OTA_CANONICAL_REQUEST_KEY_REQUIRED"
    );
  }
  const hash = createHash("sha256")
    .update(`${args.connectionId}:${requestedByUserId}:${requestKey}`)
    .digest("hex");
  return `ota-canonical-readiness:${hash}`;
}

function fingerprintValue(value: unknown): unknown {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime())
      ? { $date: value.toISOString() }
      : { $date: "INVALID" };
  }
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(fingerprintValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [
        key,
        fingerprintValue((value as Record<string, unknown>)[key]),
      ])
  );
}

function internalEvidenceFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(fingerprintValue(value)))
    .digest("hex");
}

const CANONICAL_READINESS_VALUES = new Set([
  "REQUIRED",
  "NOT_STARTED",
  "IN_PROGRESS",
  "READY",
  "BLOCKED",
]);

function readinessResultFromAudit(metadata: unknown): CanonicalOtaReadinessResult {
  const value =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : null;
  const authorizationReadiness = value?.authorizationReadiness;
  const mappingReadiness = value?.mappingReadiness;
  const distributionReadiness = value?.distributionReadiness;
  const reasons = value?.reasons;
  if (
    typeof authorizationReadiness !== "string" ||
    !CANONICAL_READINESS_VALUES.has(authorizationReadiness) ||
    typeof mappingReadiness !== "string" ||
    !CANONICAL_READINESS_VALUES.has(mappingReadiness) ||
    typeof distributionReadiness !== "string" ||
    !CANONICAL_READINESS_VALUES.has(distributionReadiness) ||
    !Array.isArray(reasons) ||
    reasons.some((reason) => typeof reason !== "string")
  ) {
    throw new CanonicalOtaReadinessServiceError(
      "OTA_CANONICAL_IDEMPOTENCY_EVIDENCE_INVALID"
    );
  }
  return {
    authorizationReadiness:
      authorizationReadiness as CanonicalOtaReadinessResult["authorizationReadiness"],
    mappingReadiness:
      mappingReadiness as CanonicalOtaReadinessResult["mappingReadiness"],
    distributionReadiness:
      distributionReadiness as CanonicalOtaReadinessResult["distributionReadiness"],
    reasons: [...reasons] as string[],
  };
}

function replayCanonicalReadinessAudit(args: {
  audit: CanonicalReadinessAuditRecord;
  organizationId: string;
  propertyId: string;
  connectionId: string;
  requestedByUserId: string;
  currentReadinessRevision: number;
}): CanonicalOtaReadinessResult {
  const metadata =
    args.audit.metadata &&
    typeof args.audit.metadata === "object" &&
    !Array.isArray(args.audit.metadata)
      ? (args.audit.metadata as Record<string, unknown>)
      : null;
  const auditRevision =
    metadata?.readinessRevision &&
    typeof metadata.readinessRevision === "object" &&
    !Array.isArray(metadata.readinessRevision)
      ? (metadata.readinessRevision as Record<string, unknown>).canonical
      : null;
  const auditPreviousRevision =
    metadata?.readinessRevision &&
    typeof metadata.readinessRevision === "object" &&
    !Array.isArray(metadata.readinessRevision)
      ? (metadata.readinessRevision as Record<string, unknown>).previous
      : null;
  if (
    args.audit.organizationId !== args.organizationId ||
    args.audit.propertyId !== args.propertyId ||
    args.audit.entityType !== "DISTRIBUTION" ||
    args.audit.entityId !== args.connectionId ||
    args.audit.engine !== "OTA_DISTRIBUTION" ||
    args.audit.eventType !== "DECISION_APPLIED" ||
    args.audit.status !== "SUCCESS" ||
    metadata?.requestedByUserId !== args.requestedByUserId ||
    !Number.isSafeInteger(auditPreviousRevision) ||
    (auditPreviousRevision as number) < 0 ||
    !Number.isSafeInteger(auditRevision) ||
    auditRevision !== (auditPreviousRevision as number) + 1 ||
    auditRevision !== args.currentReadinessRevision
  ) {
    throw new CanonicalOtaReadinessServiceError(
      "OTA_CANONICAL_IDEMPOTENCY_EVIDENCE_INVALID"
    );
  }
  return readinessResultFromAudit(metadata);
}

class CanonicalReadinessCasConflict extends Error {}

function isRetryableCanonicalConflict(error: unknown): boolean {
  if (error instanceof CanonicalReadinessCasConflict) return true;
  if (!error || typeof error !== "object") return false;
  const code =
    "code" in error && typeof error.code === "string" ? error.code : null;
  if (code === "P2034") return true;
  if (code !== "P2002") return false;
  const meta = "meta" in error ? (error as { meta?: unknown }).meta : null;
  return JSON.stringify(meta).includes("decisionId");
}

function latestDate(left: Date | null, right: Date | null): Date | null {
  if (!left) return right ? new Date(right) : null;
  if (!right) return new Date(left);
  return left.getTime() >= right.getTime()
    ? new Date(left)
    : new Date(right);
}

function lifecycleReadinessFrontier(
  occurredAtMicros: bigint | null
): Date | null {
  if (occurredAtMicros === null || occurredAtMicros < 0n) return null;
  const ceilingMilliseconds = (occurredAtMicros + 999n) / 1000n;
  const numericMilliseconds = Number(ceilingMilliseconds);
  if (!Number.isSafeInteger(numericMilliseconds)) {
    throw new CanonicalOtaReadinessServiceError(
      "OTA_CANONICAL_LIFECYCLE_WATERMARK_INVALID"
    );
  }
  return new Date(numericMilliseconds);
}

async function resolveExactChannel(args: {
  transport: ChannexReadonlyTransport;
  provider: ConnectionCenterProvider;
  storedChannelId: string | null;
  expectedAirbnbListingId: string | null;
  expectedGroupId: string;
  expectedPropertyId: string;
  expectedRoomTypeId: string;
  expectedRatePlanId: string;
}): Promise<ResolvedChannelEvidence> {
  let channelId = String(args.storedChannelId ?? "").trim() || null;
  let discovery: ChannexChannelDiscoveryResult | null = null;
  let resolutionReason: ResolvedChannelEvidence["resolutionReason"] = null;

  try {
    const collection = await args.transport.listChannels(
      args.expectedPropertyId,
      documentedChannexAdapterCode(args.provider)
    );
    discovery = discoverUniqueChannexChannel({
      payload: collection,
      provider: args.provider,
      expectedPropertyId: args.expectedPropertyId,
    });
  } catch (error) {
    if (
      error instanceof ChannexChannelIdentityError &&
      error.code === "OTA_CHANNEL_COLLECTION_RESPONSE_INVALID"
    ) {
      return {
        discovery: null,
        resolutionReason: "CHANNEL_COLLECTION_CONTRACT_INVALID",
        channelId: null,
        canonicalChannelCode: null,
        verification: null,
      };
    }
    throw error;
  }
  if (discovery.outcome !== "FOUND") {
    resolutionReason =
      discovery.outcome === "AMBIGUOUS"
        ? "CHANNEL_DISCOVERY_AMBIGUOUS"
        : "CHANNEL_DISCOVERY_NOT_FOUND";
    return {
      discovery,
      resolutionReason,
      channelId: null,
      canonicalChannelCode: null,
      verification: null,
    };
  }
  if (channelId && discovery.channelId !== channelId) {
    return {
      discovery,
      resolutionReason: "CHANNEL_DISCOVERY_STORED_ID_MISMATCH",
      channelId: null,
      canonicalChannelCode: null,
      verification: null,
    };
  }
  channelId = discovery.channelId;

  if (!channelId) {
    throw new CanonicalOtaReadinessServiceError(
      "OTA_CANONICAL_CHANNEL_ID_RESOLUTION_INVALID"
    );
  }
  let channelPayload: unknown;
  try {
    channelPayload = await args.transport.getChannel(channelId);
  } catch (error) {
    if (
      error instanceof ChannexReadonlyTransportError &&
      error.code === "OTA_READONLY_RESOURCE_NOT_FOUND"
    ) {
      return {
        discovery,
        resolutionReason: "CHANNEL_EXACT_NOT_FOUND",
        channelId: null,
        canonicalChannelCode: null,
        verification: null,
      };
    }
    throw error;
  }
  let verification: ChannexChannelVerification;
  try {
    verification = verifyExactChannexChannel({
      payload: channelPayload,
      provider: args.provider,
      expectedChannelId: channelId,
      expectedGroupId: args.expectedGroupId,
      expectedPropertyId: args.expectedPropertyId,
      expectedRoomTypeId: args.expectedRoomTypeId,
      expectedRatePlanId: args.expectedRatePlanId,
      ...(args.expectedAirbnbListingId !== null
        ? { expectedAirbnbListingId: args.expectedAirbnbListingId }
        : {}),
    });
  } catch (error) {
    if (
      error instanceof ChannexChannelIdentityError &&
      error.code === "OTA_CHANNEL_RESOURCE_RESPONSE_INVALID"
    ) {
      return {
        discovery,
        resolutionReason: "CHANNEL_RESOURCE_CONTRACT_INVALID",
        channelId: null,
        canonicalChannelCode: null,
        verification: null,
      };
    }
    throw error;
  }
  return {
    discovery,
    resolutionReason,
    channelId,
    canonicalChannelCode: canonicalChannelCode(args.provider),
    verification,
  };
}

async function readExactResourceOrMissing(
  read: () => Promise<unknown>
): Promise<unknown> {
  try {
    return await read();
  } catch (error) {
    if (
      error instanceof ChannexReadonlyTransportError &&
      error.code === "OTA_READONLY_RESOURCE_NOT_FOUND"
    ) {
      return null;
    }
    throw error;
  }
}

function appendReason(result: CanonicalOtaReadinessResult, reason: string): void {
  if (!result.reasons.includes(reason)) result.reasons.push(reason);
}

function attentionCode(args: {
  result: CanonicalOtaReadinessResult;
  channel: ResolvedChannelEvidence;
  ariMappingVerified: boolean;
  fullSyncQualified: boolean;
  commercialPolicyApplied: boolean;
}): string | null {
  if (args.channel.resolutionReason) return args.channel.resolutionReason;
  if (args.channel.verification?.identityVerified !== true) {
    return "CHANNEL_IDENTITY_NOT_VERIFIED";
  }
  if (args.channel.verification.mappingVerified !== true) {
    return "CHANNEL_MAPPING_NOT_VERIFIED";
  }
  if (args.result.distributionReadiness === "BLOCKED") {
    return (
      args.result.reasons.at(-1) ?? "OTA_CANONICAL_READINESS_BLOCKED"
    );
  }
  if (!args.ariMappingVerified) return "OTA_ARI_CANONICAL_MAPPING_NOT_VERIFIED";
  if (!args.fullSyncQualified) return "OTA_FULL_SYNC_NOT_QUALIFIED";
  if (!args.commercialPolicyApplied) {
    return "OTA_TRANSPORT_SCOPE_POLICY_NOT_APPLIED";
  }
  return null;
}

function attentionSummary(code: string | null): string | null {
  return code
    ? `Canonical OTA readiness requires attention: ${code}`
    : null;
}

export async function reconcileCanonicalOtaReadiness(args: {
  client: CanonicalOtaReadinessClient;
  transport: ChannexReadonlyTransport;
  organizationId: string;
  propertyId: string;
  requestedByUserId: string;
  provider: ConnectionCenterProvider;
  requestKey: string;
  now?: Date;
}): Promise<CanonicalOtaReadinessResult> {
  const now = args.now ?? new Date();
  const distributionProperty = await args.client.distributionProperty.findFirst({
    where: {
      organizationId: args.organizationId,
      propertyId: args.propertyId,
      platform: "CHANNEX",
    },
    select: {
      id: true,
      organizationId: true,
      propertyId: true,
      groupId: true,
      platform: true,
      externalPropertyId: true,
      externalPrimaryRoomTypeId: true,
      externalPrimaryRatePlanId: true,
      provisioningStatus: true,
      updatedAt: true,
      property: {
        select: {
          id: true,
          organizationId: true,
        },
      },
      group: {
        select: {
          id: true,
          organizationId: true,
          platform: true,
          externalGroupId: true,
          provisioningStatus: true,
          updatedAt: true,
        },
      },
    },
  });
  if (!distributionProperty) {
    throw new CanonicalOtaReadinessServiceError(
      "OTA_CANONICAL_DISTRIBUTION_PROPERTY_NOT_FOUND"
    );
  }

  const connection = await args.client.otaChannelConnection.findFirst({
    where: {
      organizationId: args.organizationId,
      propertyId: args.propertyId,
      distributionPropertyId: distributionProperty.id,
      provider: args.provider,
    },
    select: {
      id: true,
      organizationId: true,
      propertyId: true,
      distributionPropertyId: true,
      provider: true,
      externalConnectionId: true,
      externalChannelCode: true,
      externalListingId: true,
      status: true,
      paymentReadiness: true,
      taxReadiness: true,
      contentReadiness: true,
      activationRequestedAt: true,
      activatedAt: true,
      lastFullSyncConfirmedAt: true,
      lastLifecycleOccurredAt: true,
      lastLifecycleOccurredAtMicros: true,
      lastLifecycleEventType: true,
      lastLifecycleEventPrecedence: true,
      channelAuthorizationVerifiedAt: true,
      lastChannelActivatedAt: true,
      readinessRevision: true,
      updatedAt: true,
    },
  });
  if (!connection) {
    throw new CanonicalOtaReadinessServiceError(
      "OTA_CANONICAL_CHANNEL_CONNECTION_NOT_FOUND"
    );
  }
  if (
    !distributionProperty.property ||
    distributionProperty.property.id !== distributionProperty.propertyId ||
    distributionProperty.property.organizationId !==
      distributionProperty.organizationId ||
    connection.organizationId !== distributionProperty.organizationId ||
    connection.propertyId !== distributionProperty.propertyId ||
    connection.distributionPropertyId !== distributionProperty.id ||
    connection.provider !== args.provider
  ) {
    throw new CanonicalOtaReadinessServiceError(
      "OTA_DISTRIBUTION_TENANT_MISMATCH"
    );
  }

  const distributionGroup = requiredDistributionGroup(distributionProperty);
  const externalGroupId = distributionGroup.externalGroupId;

  const decisionId = readinessDecisionId({
    connectionId: connection.id,
    requestedByUserId: args.requestedByUserId,
    requestKey: args.requestKey,
  });
  const priorDecision = await args.client.apmsAuditEntry.findUnique({
    where: { decisionId },
    select: {
      id: true,
      organizationId: true,
      propertyId: true,
      entityType: true,
      entityId: true,
      engine: true,
      eventType: true,
      status: true,
      metadata: true,
    },
  });
  if (priorDecision) {
    const replayConnection = await args.client.otaChannelConnection.findFirst({
      where: {
        id: connection.id,
        organizationId: args.organizationId,
        propertyId: args.propertyId,
        provider: args.provider,
      },
      select: {
        id: true,
        organizationId: true,
        propertyId: true,
        readinessRevision: true,
      },
    });
    if (
      !replayConnection ||
      replayConnection.id !== connection.id ||
      replayConnection.organizationId !== args.organizationId ||
      replayConnection.propertyId !== args.propertyId
    ) {
      throw new CanonicalOtaReadinessServiceError(
        "OTA_CANONICAL_IDEMPOTENCY_EVIDENCE_INVALID"
      );
    }
    return replayCanonicalReadinessAudit({
      audit: priorDecision,
      organizationId: args.organizationId,
      propertyId: args.propertyId,
      connectionId: connection.id,
      requestedByUserId: String(args.requestedByUserId).trim(),
      currentReadinessRevision: validatedReadinessRevision(
        replayConnection.readinessRevision
      ),
    });
  }

  const externalPropertyId = requiredExternalId(
    distributionProperty.externalPropertyId,
    "OTA_CANONICAL_PROPERTY_ID_REQUIRED"
  );
  const externalRoomTypeId = requiredExternalId(
    distributionProperty.externalPrimaryRoomTypeId,
    "OTA_CANONICAL_ROOM_TYPE_ID_REQUIRED"
  );
  const externalRatePlanId = requiredExternalId(
    distributionProperty.externalPrimaryRatePlanId,
    "OTA_CANONICAL_RATE_PLAN_ID_REQUIRED"
  );
  const watermark = lifecycleWatermark(connection);
  const initialReadinessRevision = readinessRevision(connection);
  const lifecycleFrontierAt = lifecycleReadinessFrontier(
    watermark.occurredAtMicros
  );
  const ariPropertyStateReader = args.client.channexAriPropertyState;
  if (!ariPropertyStateReader) {
    throw new CanonicalOtaReadinessServiceError(
      "OTA_ARI_PROPERTY_STATE_READER_UNAVAILABLE"
    );
  }

  const [
    channel,
    propertyPayload,
    roomTypePayload,
    ratePlanPayload,
    propertyState,
    pmsListings,
  ] =
    await Promise.all([
      resolveExactChannel({
        transport: args.transport,
        provider: args.provider,
        storedChannelId: connection.externalConnectionId,
        expectedAirbnbListingId:
          args.provider === "AIRBNB" ? connection.externalListingId : null,
        expectedGroupId: externalGroupId,
        expectedPropertyId: externalPropertyId,
        expectedRoomTypeId: externalRoomTypeId,
        expectedRatePlanId: externalRatePlanId,
      }),
      readExactResourceOrMissing(() =>
        args.transport.getProperty(externalPropertyId)
      ),
      readExactResourceOrMissing(() =>
        args.transport.getRoomType(externalRoomTypeId)
      ),
      readExactResourceOrMissing(() =>
        args.transport.getRatePlan(ratePlanId)
      ),
      ariPropertyStateReader.findUnique({
        where: { propertyId: args.propertyId },
        select: {
          organizationId: true,
          propertyId: true,
          lastFullSyncRequestedAt: true,
          lastFullSyncCompletedAt: true,
          updatedAt: true,
        },
      }),
      args.client.pmsListing.findMany({
        where: {
          propertyId: args.propertyId,
          connection: {
            organizationId: args.organizationId,
            provider: "CHANNEX",
          },
        },
        orderBy: { id: "asc" },
        take: 2,
        select: {
          id: true,
          connectionId: true,
          propertyId: true,
          externalListingId: true,
          metadata: true,
          updatedAt: true,
          connection: {
            select: {
              id: true,
              organizationId: true,
              provider: true,
              status: true,
              updatedAt: true,
            },
          },
        },
      }),
    ]);

  const fullSyncOutboxEvidence = propertyState?.lastFullSyncRequestedAt
    ? await args.client.distributionOutboxEvent.findMany({
        where: {
          organizationId: args.organizationId,
          propertyId: args.propertyId,
          provider: "CHANNEX",
          syncMode: "FULL",
          scope: "FULL_HORIZON",
          status: "MERGED",
          correlationId: { not: null },
          createdAt: { gte: propertyState.lastFullSyncRequestedAt },
        },
        orderBy: [{ correlationId: "asc" }, { messageKind: "asc" }, { id: "asc" }],
        take: 3,
        select: {
          id: true,
          organizationId: true,
          propertyId: true,
          provider: true,
          messageKind: true,
          syncMode: true,
          scope: true,
          dateFrom: true,
          dateToExclusive: true,
          dateKeys: true,
          status: true,
          correlationId: true,
          createdAt: true,
          deliveryId: true,
          delivery: {
            select: {
              id: true,
              organizationId: true,
              propertyId: true,
              connectionId: true,
              listingId: true,
              messageKind: true,
              syncMode: true,
              scope: true,
              dateFrom: true,
              dateToExclusive: true,
              dateKeys: true,
              status: true,
              sentAt: true,
              payload: true,
              payloadHash: true,
              payloadValueCount: true,
              payloadBytes: true,
            },
          },
        },
      })
    : [];

  const result = deriveCanonicalOtaReadiness({
    provider: args.provider,
    expectedPropertyId: externalPropertyId,
    expectedRoomTypeId: externalRoomTypeId,
    expectedRatePlanId: externalRatePlanId,
    propertyPayload,
    roomTypePayload,
    ratePlanPayload,
    channelVerification: channel.verification,
    channelResolutionReason: channel.resolutionReason,
    latestLifecycleEvent: watermark.event,
    channelAuthorizationVerifiedAt:
      connection.channelAuthorizationVerifiedAt ?? null,
    lastChannelActivatedAt: connection.lastChannelActivatedAt,
  });

  const solePmsListing = pmsListings.length === 1 ? pmsListings[0]! : null;
  const mappingLastChangedAt = solePmsListing
    ? latestDate(
        latestDate(
          distributionProperty.updatedAt,
          distributionGroup.updatedAt
        ),
        latestDate(
          solePmsListing.updatedAt,
          solePmsListing.connection.updatedAt
        )
      )
    : null;
  const ariMapping = validateChannexAriCanonicalMapping({
    expectedOrganizationId: args.organizationId,
    expectedPropertyId: args.propertyId,
    distributionProperty,
    pmsConnection: solePmsListing?.connection ?? null,
    pmsListing: solePmsListing,
  });
  if (!ariMapping.verified) {
    appendReason(result, `ARI_CANONICAL_MAPPING_NOT_VERIFIED:${ariMapping.reason}`);
    if (result.mappingReadiness === "READY") {
      result.mappingReadiness = "IN_PROGRESS";
    }
    if (result.distributionReadiness === "READY") {
      result.distributionReadiness = "IN_PROGRESS";
    }
  }

  const fullSync = qualifyChannexCorrelatedFullSyncEvidence({
    expectedOrganizationId: args.organizationId,
    expectedPropertyId: args.propertyId,
    expectedConnectionId: solePmsListing?.connection.id ?? "",
    expectedListingId: solePmsListing?.id ?? "",
    expectedExternalPropertyId: externalPropertyId,
    expectedExternalRoomTypeId: externalRoomTypeId,
    expectedExternalRatePlanId: externalRatePlanId,
    state: propertyState,
    outboxEvidence: fullSyncOutboxEvidence,
    lastChannelActivatedAt: connection.lastChannelActivatedAt,
    lastLifecycleOccurredAt: lifecycleFrontierAt,
    mappingLastChangedAt,
  });
  const fullSyncQualified = fullSync.qualified && ariMapping.verified;
  const fullSyncConfirmedAt = fullSyncQualified ? fullSync.confirmedAt : null;
  if (!fullSyncQualified) {
    appendReason(result, `FULL_SYNC_NOT_QUALIFIED:${fullSync.reason}`);
    if (result.distributionReadiness === "READY") {
      result.distributionReadiness = "IN_PROGRESS";
    }
  }

  const resolvedExternalConnectionId =
    channel.verification?.identityVerified === true
      ? channel.channelId
      : connection.externalConnectionId;
  const resolvedExternalChannelCode =
    channel.verification?.identityVerified === true
      ? channel.canonicalChannelCode
      : connection.externalChannelCode;
  const resolvedExternalListingId =
    args.provider === "AIRBNB" &&
    channel.verification?.mappingVerified === true &&
    channel.verification.airbnbListingId
      ? channel.verification.airbnbListingId
      : connection.externalListingId;
  const exactMappedActiveChannel =
    channel.verification?.identityVerified === true &&
    channel.verification.mappingVerified === true &&
    channel.verification.connectedEvidenceVerified === true &&
    typeof channel.verification.activeState === "boolean" &&
    resolvedExternalConnectionId &&
    resolvedExternalChannelCode
      ? {
          id: resolvedExternalConnectionId,
          channelCode: resolvedExternalChannelCode,
          isActive: channel.verification.activeState,
        }
      : null;
  const commercialPolicy = deriveChannexAirbnbTransportReadiness({
    provider: args.provider,
    expectedExternalConnectionId: resolvedExternalConnectionId,
    expectedExternalChannelCode: resolvedExternalChannelCode,
    observedChannel: exactMappedActiveChannel,
    mapping: ariMapping,
  });
  if (!commercialPolicy.applied) {
    appendReason(
      result,
      `TRANSPORT_SCOPE_POLICY_NOT_APPLIED:${commercialPolicy.reason}`
    );
  }

  const fullSyncRequiredAfterAt = latestDate(
    latestDate(connection.lastChannelActivatedAt, lifecycleFrontierAt),
    mappingLastChangedAt
  );
  const activation = planCanonicalOtaActivation({
    current: connection.status,
    evidence: {
      distributionPropertyStatus: distributionProperty.provisioningStatus,
      externalConnectionId: resolvedExternalConnectionId,
      authorizationReadiness: result.authorizationReadiness,
      mappingReadiness: result.mappingReadiness,
      distributionReadiness: result.distributionReadiness,
      ...commercialPolicy.readiness,
      lastFullSyncConfirmedAt: fullSyncConfirmedAt,
      fullSyncRequiredAfterAt,
    },
  });
  const lastErrorCode = attentionCode({
    result,
    channel,
    ariMappingVerified: ariMapping.verified,
    fullSyncQualified,
    commercialPolicyApplied: commercialPolicy.applied,
  });
  const expectedInternalEvidenceFingerprint = internalEvidenceFingerprint({
    distributionProperty,
    propertyState,
    pmsListings,
    fullSyncOutboxEvidence,
  });

  const applyDecision = () =>
    args.client.$transaction(async (tx) => {
      const existingAudit = await tx.apmsAuditEntry.findUnique({
        where: { decisionId },
        select: {
          id: true,
          organizationId: true,
          propertyId: true,
          entityType: true,
          entityId: true,
          engine: true,
          eventType: true,
          status: true,
          metadata: true,
        },
      });
      if (existingAudit) {
        const replayConnection = await tx.otaChannelConnection.findFirst({
          where: {
            id: connection.id,
            organizationId: args.organizationId,
            propertyId: args.propertyId,
            provider: args.provider,
          },
          select: {
            id: true,
            organizationId: true,
            propertyId: true,
            readinessRevision: true,
          },
        });
        if (
          !replayConnection ||
          replayConnection.id !== connection.id ||
          replayConnection.organizationId !== args.organizationId ||
          replayConnection.propertyId !== args.propertyId
        ) {
          throw new CanonicalOtaReadinessServiceError(
            "OTA_CANONICAL_IDEMPOTENCY_EVIDENCE_INVALID"
          );
        }
        return replayCanonicalReadinessAudit({
          audit: existingAudit,
          organizationId: args.organizationId,
          propertyId: args.propertyId,
          connectionId: connection.id,
          requestedByUserId: String(args.requestedByUserId).trim(),
          currentReadinessRevision: validatedReadinessRevision(
            replayConnection.readinessRevision
          ),
        });
      }

      const txAriPropertyStateReader = tx.channexAriPropertyState;
      if (!txAriPropertyStateReader) {
        throw new CanonicalOtaReadinessServiceError(
          "OTA_ARI_PROPERTY_STATE_READER_UNAVAILABLE"
        );
      }
      const [
        currentDistributionProperty,
        currentPropertyState,
        currentPmsListings,
        currentFullSyncOutboxEvidence,
      ] = await Promise.all([
        tx.distributionProperty.findFirst({
          where: {
            id: distributionProperty.id,
            organizationId: args.organizationId,
            propertyId: args.propertyId,
            platform: "CHANNEX",
          },
          select: {
            id: true,
            organizationId: true,
            propertyId: true,
            groupId: true,
            platform: true,
            externalPropertyId: true,
            externalPrimaryRoomTypeId: true,
            externalPrimaryRatePlanId: true,
            provisioningStatus: true,
            updatedAt: true,
            property: {
              select: {
                id: true,
                organizationId: true,
              },
            },
            group: {
              select: {
                id: true,
                organizationId: true,
                platform: true,
                externalGroupId: true,
                provisioningStatus: true,
                updatedAt: true,
              },
            },
          },
        }),
        txAriPropertyStateReader.findUnique({
          where: { propertyId: args.propertyId },
          select: {
            organizationId: true,
            propertyId: true,
            lastFullSyncRequestedAt: true,
            lastFullSyncCompletedAt: true,
            updatedAt: true,
          },
        }),
        tx.pmsListing.findMany({
          where: {
            propertyId: args.propertyId,
            connection: {
              organizationId: args.organizationId,
              provider: "CHANNEX",
            },
          },
          orderBy: { id: "asc" },
          take: 2,
          select: {
            id: true,
            connectionId: true,
            propertyId: true,
            externalListingId: true,
            metadata: true,
            updatedAt: true,
            connection: {
              select: {
                id: true,
                organizationId: true,
                provider: true,
                status: true,
                updatedAt: true,
              },
            },
          },
        }),
        propertyState?.lastFullSyncRequestedAt
          ? tx.distributionOutboxEvent.findMany({
              where: {
                organizationId: args.organizationId,
                propertyId: args.propertyId,
                provider: "CHANNEX",
                syncMode: "FULL",
                scope: "FULL_HORIZON",
                status: "MERGED",
                correlationId: { not: null },
                createdAt: { gte: propertyState.lastFullSyncRequestedAt },
              },
              orderBy: [
                { correlationId: "asc" },
                { messageKind: "asc" },
                { id: "asc" },
              ],
              take: 3,
              select: {
                id: true,
                organizationId: true,
                propertyId: true,
                provider: true,
                messageKind: true,
                syncMode: true,
                scope: true,
                dateFrom: true,
                dateToExclusive: true,
                dateKeys: true,
                status: true,
                correlationId: true,
                createdAt: true,
                deliveryId: true,
                delivery: {
                  select: {
                    id: true,
                    organizationId: true,
                    propertyId: true,
                    connectionId: true,
                    listingId: true,
                    messageKind: true,
                    syncMode: true,
                    scope: true,
                    dateFrom: true,
                    dateToExclusive: true,
                    dateKeys: true,
                    status: true,
                    sentAt: true,
                    payload: true,
                    payloadHash: true,
                    payloadValueCount: true,
                    payloadBytes: true,
                  },
                },
              },
            })
          : Promise.resolve([]),
      ]);
      const currentInternalEvidenceFingerprint = internalEvidenceFingerprint({
        distributionProperty: currentDistributionProperty,
        propertyState: currentPropertyState,
        pmsListings: currentPmsListings,
        fullSyncOutboxEvidence: currentFullSyncOutboxEvidence,
      });
      if (
        currentInternalEvidenceFingerprint !==
        expectedInternalEvidenceFingerprint
      ) {
        throw new CanonicalOtaReadinessServiceError(
          "OTA_CANONICAL_INTERNAL_EVIDENCE_CONFLICT"
        );
      }

      const updated = await tx.otaChannelConnection.updateMany({
      where: {
        id: connection.id,
        organizationId: args.organizationId,
        propertyId: args.propertyId,
        distributionPropertyId: distributionProperty.id,
        provider: args.provider,
        status: connection.status,
        externalConnectionId: connection.externalConnectionId,
        externalChannelCode: connection.externalChannelCode,
        externalListingId: connection.externalListingId,
        updatedAt: connection.updatedAt,
        lastLifecycleOccurredAt: connection.lastLifecycleOccurredAt,
        lastLifecycleOccurredAtMicros:
          connection.lastLifecycleOccurredAtMicros,
        lastLifecycleEventType: connection.lastLifecycleEventType,
        lastLifecycleEventPrecedence: connection.lastLifecycleEventPrecedence,
        channelAuthorizationVerifiedAt:
          connection.channelAuthorizationVerifiedAt ?? null,
        lastChannelActivatedAt: connection.lastChannelActivatedAt,
        readinessRevision: initialReadinessRevision,
      },
      data: {
        status: activation.next,
        externalConnectionId: resolvedExternalConnectionId,
        externalChannelCode: resolvedExternalChannelCode,
        externalListingId: resolvedExternalListingId,
        authorizationReadiness: result.authorizationReadiness,
        mappingReadiness: result.mappingReadiness,
        distributionReadiness: result.distributionReadiness,
        ...commercialPolicy.readiness,
        lastFullSyncConfirmedAt: fullSyncConfirmedAt,
        lastReadinessCheckedAt: now,
        lastErrorCode,
        lastErrorSummary: attentionSummary(lastErrorCode),
        readinessRevision: { increment: 1 },
        ...(activation.next === "ACTIVE" &&
        (connection.status !== "ACTIVE" || !connection.activatedAt) &&
        fullSyncConfirmedAt
          ? { activatedAt: fullSyncConfirmedAt }
          : activation.next !== "ACTIVE"
            ? { activatedAt: null }
            : {}),
      },
      });
      if (updated.count !== 1) {
        throw new CanonicalReadinessCasConflict();
      }

      await tx.apmsAuditEntry.create({
        data: {
        organizationId: args.organizationId,
        propertyId: args.propertyId,
        entityType: "DISTRIBUTION",
        entityId: connection.id,
        engine: "OTA_DISTRIBUTION",
        eventType: "DECISION_APPLIED",
        status: "SUCCESS",
        severity: "INFO",
        decisionId,
        summary: "Canonical OTA readiness reconciled from exact Channex evidence",
        reason: result.distributionReadiness,
        metadata: {
          provider: args.provider,
          requestedByUserId: String(args.requestedByUserId).trim(),
          authorizationReadiness: result.authorizationReadiness,
          mappingReadiness: result.mappingReadiness,
          distributionReadiness: result.distributionReadiness,
          reasons: result.reasons,
          previousStatus: connection.status,
          canonicalStatus: activation.next,
          transitionPath: activation.path,
          activationBlockers: activation.blockers,
          externalGroupId,
          externalPropertyId,
          externalRoomTypeId,
          externalRatePlanId,
          resolvedExternalConnectionId,
          resolvedExternalChannelCode,
          resolvedExternalListingId,
          channelDiscoveryOutcome: channel.discovery?.outcome ?? "NOT_REQUIRED",
          channelCandidateCount: channel.discovery?.candidateCount ?? null,
          channelVerification: channel.verification,
          lifecycleWatermark: {
            occurredAt: watermark.occurredAt?.toISOString() ?? null,
            occurredAtMicros:
              watermark.occurredAtMicros?.toString() ?? null,
            eventType: watermark.event,
            precedence: watermark.precedence,
            channelAuthorizationVerifiedAt:
              connection.channelAuthorizationVerifiedAt?.toISOString() ?? null,
            lastChannelActivatedAt:
              connection.lastChannelActivatedAt?.toISOString() ?? null,
          },
          readinessRevision: {
            previous: initialReadinessRevision,
            canonical: initialReadinessRevision + 1,
          },
          ariCanonicalMapping: {
            ...ariMapping,
            listingCardinality: pmsListings.length,
          },
          fullSyncEvidence: {
            evidenceLevel: fullSync.evidenceType,
            qualified: fullSyncQualified,
            qualificationReason: ariMapping.verified
              ? fullSync.reason
              : "ARI_CANONICAL_MAPPING_NOT_VERIFIED",
            correlationId: fullSync.correlationId,
            mappingFingerprint: fullSync.mappingFingerprint,
            requestedAt: fullSync.requestedAt?.toISOString() ?? null,
            completedAt: fullSync.completedAt?.toISOString() ?? null,
            frontierAt: fullSync.frontierAt?.toISOString() ?? null,
            mappingLastChangedAt:
              mappingLastChangedAt?.toISOString() ?? null,
            otaAcceptanceVerified: false,
          },
          transportScopePolicy: {
            applied: commercialPolicy.applied,
            reason: commercialPolicy.reason,
            readiness: commercialPolicy.readiness,
            ...commercialPolicy.metadata,
          },
        },
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        },
      });
      return null;
    }, { isolationLevel: "Serializable" });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const persistedResult = await applyDecision();
      return persistedResult ?? result;
    } catch (error) {
      if (!isRetryableCanonicalConflict(error)) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "P2002"
        ) {
          throw new CanonicalOtaReadinessServiceError(
            "OTA_CANONICAL_PERSISTENCE_CONFLICT"
          );
        }
        throw error;
      }
      if (attempt === 2) {
        throw new CanonicalOtaReadinessServiceError(
          "OTA_CANONICAL_READINESS_STATE_CONFLICT"
        );
      }
    }
  }

  throw new CanonicalOtaReadinessServiceError(
    "OTA_CANONICAL_READINESS_STATE_CONFLICT"
  );
}