import { createHash } from "node:crypto";

import type { ConnectionCenterProvider } from "./connection-center.read-model.js";
import type { ChannexReadonlyTransport } from "./channex-readonly.http-transport.js";
import {
  deriveCanonicalOtaReadiness,
  type CanonicalOtaReadinessResult,
} from "./channex-canonical-readiness.reconciler.js";
import {
  planCanonicalOtaActivation,
  type OtaChannelConnectionStatus,
  type OtaReadinessStatus,
} from "./ota-commercial-lifecycle.policy.js";

const LIFECYCLE_EVENTS = new Set([
  "new_channel",
  "updated_channel",
  "activate_channel",
  "deactivate_channel",
  "disconnect_channel",
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
  provisioningStatus: "NOT_PROVISIONED" | "PROVISIONING" | "READY" | "FAILED";
};

type ConnectionRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  distributionPropertyId: string;
  provider: ConnectionCenterProvider;
  externalConnectionId: string | null;
  externalChannelCode: string | null;
  status: OtaChannelConnectionStatus;
  paymentReadiness: OtaReadinessStatus;
  taxReadiness: OtaReadinessStatus;
  contentReadiness: OtaReadinessStatus;
  activationRequestedAt: Date | null;
  activatedAt: Date | null;
  lastFullSyncConfirmedAt: Date | null;
};

type CanonicalReadinessTransaction = {
  otaChannelConnection: {
    updateMany(args: any): Promise<{ count: number }>;
  };
  apmsAuditEntry: {
    findUnique(args: any): Promise<{ id: string } | null>;
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
  apmsAuditEntry: {
    findFirst(args: any): Promise<{ reason: string | null } | null>;
  };
  $transaction<T>(work: (tx: CanonicalReadinessTransaction) => Promise<T>): Promise<T>;
};

function requiredExternalId(value: string | null, code: string): string {
  const result = String(value ?? "").trim();
  if (!result) throw new CanonicalOtaReadinessServiceError(code);
  return result;
}

function lifecycleEvent(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  const normalized = raw === "disconnected_channel" ? "disconnect_channel" : raw;
  return LIFECYCLE_EVENTS.has(normalized)
    ? (normalized as
        | "new_channel"
        | "updated_channel"
        | "activate_channel"
        | "deactivate_channel"
        | "disconnect_channel"
        | "disconnect_listing")
    : null;
}

function readinessDecisionId(args: {
  connectionId: string;
  requestKey: string;
}): string {
  const requestKey = String(args.requestKey ?? "").trim();
  if (!requestKey) {
    throw new CanonicalOtaReadinessServiceError("OTA_CANONICAL_REQUEST_KEY_REQUIRED");
  }
  const hash = createHash("sha256")
    .update(`${args.connectionId}:${requestKey}`)
    .digest("hex");
  return `ota-canonical-readiness:${hash}`;
}

export async function reconcileCanonicalOtaReadiness(args: {
  client: CanonicalOtaReadinessClient;
  transport: ChannexReadonlyTransport;
  organizationId: string;
  propertyId: string;
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
      externalPropertyId: true,
      externalPrimaryRoomTypeId: true,
      externalPrimaryRatePlanId: true,
      provisioningStatus: true,
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
      status: true,
      paymentReadiness: true,
      taxReadiness: true,
      contentReadiness: true,
      activationRequestedAt: true,
      activatedAt: true,
      lastFullSyncConfirmedAt: true,
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
  const decisionId = readinessDecisionId({
    connectionId: connection.id,
    requestKey: args.requestKey,
  });

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
  const activation = planCanonicalOtaActivation({
    current: connection.status,
    evidence: {
      distributionPropertyStatus: distributionProperty.provisioningStatus,
      externalConnectionId: connection.externalConnectionId,
      authorizationReadiness: result.authorizationReadiness,
      mappingReadiness: result.mappingReadiness,
      distributionReadiness: result.distributionReadiness,
      paymentReadiness: connection.paymentReadiness,
      taxReadiness: connection.taxReadiness,
      contentReadiness: connection.contentReadiness,
      lastFullSyncConfirmedAt: connection.lastFullSyncConfirmedAt,
    },
  });

  await args.client.$transaction(async (tx) => {
    const existingAudit = await tx.apmsAuditEntry.findUnique({
      where: { decisionId },
      select: { id: true },
    });
    if (existingAudit) return;

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
      },
      data: {
        status: activation.next,
        authorizationReadiness: result.authorizationReadiness,
        mappingReadiness: result.mappingReadiness,
        distributionReadiness: result.distributionReadiness,
        lastReadinessCheckedAt: now,
        lastErrorCode:
          result.distributionReadiness === "BLOCKED"
            ? result.reasons[result.reasons.length - 1] ?? "OTA_CANONICAL_READINESS_BLOCKED"
            : null,
        ...(activation.path.includes("ACTIVATION_PENDING") &&
        !connection.activationRequestedAt
          ? { activationRequestedAt: now }
          : {}),
        ...(activation.next === "ACTIVE" && !connection.activatedAt
          ? { activatedAt: now }
          : {}),
      },
    });
    if (updated.count !== 1) {
      throw new CanonicalOtaReadinessServiceError("OTA_CANONICAL_READINESS_STATE_CONFLICT");
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
        summary: "Canonical OTA readiness reconciled from Channex read-only evidence",
        reason: result.distributionReadiness,
        metadata: {
          provider: args.provider,
          authorizationReadiness: result.authorizationReadiness,
          mappingReadiness: result.mappingReadiness,
          distributionReadiness: result.distributionReadiness,
          reasons: result.reasons,
          previousStatus: connection.status,
          canonicalStatus: activation.next,
          transitionPath: activation.path,
          activationBlockers: activation.blockers,
          externalPropertyId,
          externalRoomTypeId,
          externalRatePlanId,
        },
        startedAt: now,
        completedAt: now,
        durationMs: 0,
      },
    });
  });

  return result;
}
