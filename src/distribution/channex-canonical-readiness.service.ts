import type { ConnectionCenterProvider } from "./connection-center.read-model.js";
import type { ChannexReadonlyTransport } from "./channex-readonly.http-transport.js";
import {
  deriveCanonicalOtaReadiness,
  type CanonicalOtaReadinessResult,
} from "./channex-canonical-readiness.reconciler.js";

const LIFECYCLE_EVENTS = new Set([
  "new_channel",
  "updated_channel",
  "activate_channel",
  "deactivate_channel",
  "disconnected_channel",
  "disconnect_listing",
]);

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
  externalPropertyId: string | null;
  externalPrimaryRoomTypeId: string | null;
  externalPrimaryRatePlanId: string | null;
};

type ConnectionRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  distributionPropertyId: string;
  provider: ConnectionCenterProvider;
  externalConnectionId: string | null;
  externalChannelCode: string | null;
};

export type CanonicalOtaReadinessClient = {
  distributionProperty: {
    findFirst(args: any): Promise<DistributionPropertyRecord | null>;
  };
  otaChannelConnection: {
    findFirst(args: any): Promise<ConnectionRecord | null>;
    updateMany(args: any): Promise<{ count: number }>;
  };
  apmsAuditEntry: {
    findFirst(args: any): Promise<{ reason: string | null } | null>;
    create(args: any): Promise<unknown>;
  };
};

function requiredExternalId(value: string | null, code: string): string {
  const result = String(value ?? "").trim();
  if (!result) throw new CanonicalOtaReadinessServiceError(code);
  return result;
}

function lifecycleEvent(value: string | null | undefined) {
  const normalized = String(value ?? "").trim();
  return LIFECYCLE_EVENTS.has(normalized)
    ? (normalized as
        | "new_channel"
        | "updated_channel"
        | "activate_channel"
        | "deactivate_channel"
        | "disconnected_channel"
        | "disconnect_listing")
    : null;
}

export async function reconcileCanonicalOtaReadiness(args: {
  client: CanonicalOtaReadinessClient;
  transport: ChannexReadonlyTransport;
  organizationId: string;
  propertyId: string;
  provider: ConnectionCenterProvider;
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
      externalPropertyId: true,
      externalPrimaryRoomTypeId: true,
      externalPrimaryRatePlanId: true,
    },
  });
  if (!distributionProperty) {
    throw new CanonicalOtaReadinessServiceError("OTA_CANONICAL_DISTRIBUTION_PROPERTY_NOT_FOUND");
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
    },
  });
  if (!connection) {
    throw new CanonicalOtaReadinessServiceError("OTA_CANONICAL_CHANNEL_CONNECTION_NOT_FOUND");
  }
  if (
    connection.organizationId !== distributionProperty.organizationId ||
    connection.propertyId !== distributionProperty.propertyId ||
    connection.distributionPropertyId !== distributionProperty.id ||
    connection.provider !== args.provider
  ) {
    throw new CanonicalOtaReadinessServiceError("OTA_DISTRIBUTION_TENANT_MISMATCH");
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

  const latestLifecycleAudit = await args.client.apmsAuditEntry.findFirst({
    where: {
      organizationId: args.organizationId,
      propertyId: args.propertyId,
      entityType: "DISTRIBUTION",
      entityId: connection.id,
      engine: "OTA_DISTRIBUTION",
      summary: "Channex OTA channel lifecycle evidence ingested",
      status: "SUCCESS",
    },
    orderBy: { createdAt: "desc" },
    select: { reason: true },
  });

  const [propertyPayload, roomTypesPayload, ratePlansPayload] = await Promise.all([
    args.transport.getProperty(externalPropertyId),
    args.transport.listRoomTypes(externalPropertyId),
    args.transport.listRatePlans(externalPropertyId),
  ]);

  const result = deriveCanonicalOtaReadiness({
    provider: args.provider,
    expectedPropertyId: externalPropertyId,
    expectedRoomTypeId: externalRoomTypeId,
    expectedRatePlanId: externalRatePlanId,
    externalConnectionId: connection.externalConnectionId,
    externalChannelCode: connection.externalChannelCode,
    propertyPayload,
    roomTypesPayload,
    ratePlansPayload,
    latestLifecycleEvent: lifecycleEvent(latestLifecycleAudit?.reason),
  });

  const updated = await args.client.otaChannelConnection.updateMany({
    where: {
      id: connection.id,
      organizationId: args.organizationId,
      propertyId: args.propertyId,
      distributionPropertyId: distributionProperty.id,
      provider: args.provider,
    },
    data: {
      authorizationReadiness: result.authorizationReadiness,
      mappingReadiness: result.mappingReadiness,
      distributionReadiness: result.distributionReadiness,
      lastReadinessCheckedAt: now,
      lastErrorCode:
        result.distributionReadiness === "BLOCKED"
          ? result.reasons[result.reasons.length - 1] ?? "OTA_CANONICAL_READINESS_BLOCKED"
          : null,
    },
  });
  if (updated.count !== 1) {
    throw new CanonicalOtaReadinessServiceError("OTA_CANONICAL_READINESS_STATE_CONFLICT");
  }

  await args.client.apmsAuditEntry.create({
    data: {
      organizationId: args.organizationId,
      propertyId: args.propertyId,
      entityType: "DISTRIBUTION",
      entityId: connection.id,
      engine: "OTA_DISTRIBUTION",
      eventType: "DECISION_APPLIED",
      status: "SUCCESS",
      severity: "INFO",
      summary: "Canonical OTA readiness reconciled from Channex read-only evidence",
      reason: result.distributionReadiness,
      metadata: {
        provider: args.provider,
        authorizationReadiness: result.authorizationReadiness,
        mappingReadiness: result.mappingReadiness,
        distributionReadiness: result.distributionReadiness,
        reasons: result.reasons,
        externalPropertyId,
        externalRoomTypeId,
        externalRatePlanId,
      },
      startedAt: now,
      completedAt: now,
      durationMs: 0,
    },
  });

  return result;
}
