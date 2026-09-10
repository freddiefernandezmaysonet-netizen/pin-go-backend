import { createHash } from "node:crypto";

import {
  AirbnbHostSelfServiceError,
  verifyAirbnbHostCallback,
} from "./airbnb-host-self-service.service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LOCAL_RETRIES = 2;

const CONNECTION_SELECT = {
  id: true,
  organizationId: true,
  propertyId: true,
  distributionPropertyId: true,
  provider: true,
  status: true,
  externalConnectionId: true,
  readinessRevision: true,
  updatedAt: true,
  distributionProperty: {
    select: {
      id: true,
      organizationId: true,
      propertyId: true,
      groupId: true,
      platform: true,
      provisioningStatus: true,
      externalPropertyId: true,
      updatedAt: true,
      group: {
        select: {
          id: true,
          organizationId: true,
          platform: true,
          provisioningStatus: true,
          externalGroupId: true,
          updatedAt: true,
        },
      },
    },
  },
} as const;

export type AirbnbCallbackPersistenceTransaction = {
  otaChannelConnection: {
    findFirst(args: any): Promise<any>;
    updateMany(args: any): Promise<{ count: number }>;
  };
  apmsAuditEntry: {
    findUnique(args: any): Promise<any>;
    create(args: any): Promise<unknown>;
  };
};

export type AirbnbCallbackPersistenceClient = {
  otaChannelConnection: {
    findFirst(args: any): Promise<any>;
  };
  $transaction<T>(
    work: (tx: AirbnbCallbackPersistenceTransaction) => Promise<T>,
    options?: { isolationLevel?: "Serializable" }
  ): Promise<T>;
};

export type AirbnbCallbackPersistenceGuard = {
  connectionId: string;
  organizationId: string;
  propertyId: string;
  distributionPropertyId: string;
  externalConnectionId: string | null;
  fingerprint: string;
};

class AirbnbCallbackPersistenceCasConflict extends Error {}

function required(value: unknown, code: string, max = 255): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > max) throw new AirbnbHostSelfServiceError(code);
  return result;
}

function uuid(value: unknown, code: string): string {
  const result = required(value, code, 120);
  if (!UUID.test(result)) throw new AirbnbHostSelfServiceError(code);
  return result;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function guardFromRow(value: any): AirbnbCallbackPersistenceGuard {
  const distributionProperty = value?.distributionProperty;
  const group = distributionProperty?.group;
  if (
    !value || !distributionProperty || !group ||
    typeof value.id !== "string" || !value.id ||
    typeof value.organizationId !== "string" || !value.organizationId ||
    typeof value.propertyId !== "string" || !value.propertyId ||
    typeof value.distributionPropertyId !== "string" || !value.distributionPropertyId ||
    value.provider !== "AIRBNB" ||
    typeof value.status !== "string" || !value.status ||
    !Number.isSafeInteger(value.readinessRevision) || value.readinessRevision < 0 ||
    !validDate(value.updatedAt) ||
    value.distributionPropertyId !== distributionProperty.id ||
    distributionProperty.organizationId !== value.organizationId ||
    distributionProperty.propertyId !== value.propertyId ||
    distributionProperty.platform !== "CHANNEX" ||
    distributionProperty.provisioningStatus !== "READY" ||
    typeof distributionProperty.groupId !== "string" || !distributionProperty.groupId ||
    distributionProperty.groupId !== group.id ||
    typeof distributionProperty.externalPropertyId !== "string" ||
    !UUID.test(distributionProperty.externalPropertyId) ||
    !validDate(distributionProperty.updatedAt) ||
    group.organizationId !== value.organizationId ||
    group.platform !== "CHANNEX" ||
    group.provisioningStatus !== "READY" ||
    typeof group.externalGroupId !== "string" || !UUID.test(group.externalGroupId) ||
    !validDate(group.updatedAt) ||
    (value.externalConnectionId !== null &&
      (typeof value.externalConnectionId !== "string" || !UUID.test(value.externalConnectionId)))
  ) {
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_LOCAL_SCOPE_MISMATCH");
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      connectionId: value.id,
      organizationId: value.organizationId,
      propertyId: value.propertyId,
      distributionPropertyId: value.distributionPropertyId,
      status: value.status,
      externalConnectionId: value.externalConnectionId,
      readinessRevision: value.readinessRevision,
      connectionUpdatedAt: value.updatedAt.toISOString(),
      distributionPropertyId2: distributionProperty.id,
      externalPropertyId: distributionProperty.externalPropertyId,
      distributionPropertyUpdatedAt: distributionProperty.updatedAt.toISOString(),
      groupId: group.id,
      externalGroupId: group.externalGroupId,
      groupUpdatedAt: group.updatedAt.toISOString(),
    }))
    .digest("hex");
  return {
    connectionId: value.id,
    organizationId: value.organizationId,
    propertyId: value.propertyId,
    distributionPropertyId: value.distributionPropertyId,
    externalConnectionId: value.externalConnectionId,
    fingerprint,
  };
}

function queryFor(organizationId: string, propertyId: string) {
  return {
    where: { organizationId, propertyId, provider: "AIRBNB" },
    select: CONNECTION_SELECT,
  };
}

export async function captureAirbnbCallbackPersistenceGuard(args: {
  client: Pick<AirbnbCallbackPersistenceClient, "otaChannelConnection">;
  organizationId: string;
  propertyId: string;
  channelId: string;
}): Promise<AirbnbCallbackPersistenceGuard> {
  const organizationId = required(args.organizationId, "OTA_AIRBNB_TENANT_INVALID", 120);
  const propertyId = required(args.propertyId, "OTA_AIRBNB_PROPERTY_INVALID", 120);
  const channelId = uuid(args.channelId, "OTA_AIRBNB_CHANNEL_ID_INVALID");
  const guard = guardFromRow(
    await args.client.otaChannelConnection.findFirst(queryFor(organizationId, propertyId))
  );
  if (guard.organizationId !== organizationId || guard.propertyId !== propertyId) {
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_LOCAL_SCOPE_MISMATCH");
  }
  if (guard.externalConnectionId && guard.externalConnectionId !== channelId) {
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_CHANNEL_CONFLICT");
  }
  return guard;
}

function decisionId(connectionId: string, channelId: string): string {
  const digest = createHash("sha256")
    .update(`AIRBNB_CALLBACK_RESOURCE\u0000${connectionId}\u0000${channelId}`)
    .digest("hex");
  return `airbnb-callback-resource:${digest}`;
}

function isRetryableLocalConflict(error: unknown): boolean {
  if (error instanceof AirbnbCallbackPersistenceCasConflict) return true;
  if (!error || typeof error !== "object") return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : null;
  if (code === "P2034") return true;
  if (code !== "P2002") return false;
  const meta = "meta" in error ? JSON.stringify((error as { meta?: unknown }).meta ?? null) : "";
  return meta.includes("decisionId");
}

function validateExistingAudit(args: {
  audit: any;
  organizationId: string;
  propertyId: string;
  connectionId: string;
  channelId: string;
}): void {
  const metadata =
    args.audit?.metadata && typeof args.audit.metadata === "object" && !Array.isArray(args.audit.metadata)
      ? args.audit.metadata as Record<string, unknown>
      : null;
  if (
    args.audit?.organizationId !== args.organizationId ||
    args.audit?.propertyId !== args.propertyId ||
    args.audit?.entityType !== "DISTRIBUTION" ||
    args.audit?.entityId !== args.connectionId ||
    args.audit?.engine !== "OTA_AIRBNB_CALLBACK" ||
    args.audit?.eventType !== "CALLBACK_RESOURCE_VERIFIED" ||
    args.audit?.status !== "SUCCESS" ||
    metadata?.scope !== "CALLBACK_RESOURCE_ONLY" ||
    metadata?.channelId !== args.channelId
  ) {
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_PERSISTENCE_CONFLICT");
  }
}

/**
 * Persist only the verified Channex channel reference returned by Airbnb OAuth.
 * This intentionally does NOT mutate lifecycle status/readiness, mappings,
 * activation, ARI state, reservations, or Channex lifecycle watermarks.
 */
export async function persistVerifiedAirbnbCallback(args: {
  client: AirbnbCallbackPersistenceClient;
  guard: AirbnbCallbackPersistenceGuard;
  organizationId: string;
  propertyId: string;
  requestedByUserId: string;
  channelId: string;
  now?: Date;
}): Promise<void> {
  const organizationId = required(args.organizationId, "OTA_AIRBNB_TENANT_INVALID", 120);
  const propertyId = required(args.propertyId, "OTA_AIRBNB_PROPERTY_INVALID", 120);
  const requestedByUserId = required(args.requestedByUserId, "OTA_AIRBNB_ACTOR_INVALID", 120);
  const channelId = uuid(args.channelId, "OTA_AIRBNB_CHANNEL_ID_INVALID");
  if (args.guard.organizationId !== organizationId || args.guard.propertyId !== propertyId) {
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_LOCAL_SCOPE_MISMATCH");
  }
  if (args.guard.externalConnectionId && args.guard.externalConnectionId !== channelId) {
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_CHANNEL_CONFLICT");
  }
  const now = args.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_CLOCK_INVALID");
  }

  for (let retry = 0; retry <= MAX_LOCAL_RETRIES; retry += 1) {
    try {
      await args.client.$transaction(async (tx) => {
        const row = await tx.otaChannelConnection.findFirst(queryFor(organizationId, propertyId));
        const current = guardFromRow(row);
        if (current.fingerprint !== args.guard.fingerprint) {
          throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_STATE_CHANGED");
        }
        if (current.externalConnectionId && current.externalConnectionId !== channelId) {
          throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_CHANNEL_CONFLICT");
        }

        const auditDecisionId = decisionId(current.connectionId, channelId);
        const existingAudit = await tx.apmsAuditEntry.findUnique({
          where: { decisionId: auditDecisionId },
        });
        if (existingAudit) {
          validateExistingAudit({
            audit: existingAudit,
            organizationId,
            propertyId,
            connectionId: current.connectionId,
            channelId,
          });
          if (current.externalConnectionId !== channelId) {
            throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_PERSISTENCE_CONFLICT");
          }
          return;
        }

        if (current.externalConnectionId === null) {
          const updated = await tx.otaChannelConnection.updateMany({
            where: {
              id: current.connectionId,
              organizationId,
              propertyId,
              distributionPropertyId: current.distributionPropertyId,
              provider: "AIRBNB",
              externalConnectionId: null,
              updatedAt: row.updatedAt,
              readinessRevision: row.readinessRevision,
              status: row.status,
            },
            data: { externalConnectionId: channelId },
          });
          if (updated.count !== 1) throw new AirbnbCallbackPersistenceCasConflict();
        }

        await tx.apmsAuditEntry.create({
          data: {
            organizationId,
            propertyId,
            entityType: "DISTRIBUTION",
            entityId: current.connectionId,
            engine: "OTA_AIRBNB_CALLBACK",
            eventType: "CALLBACK_RESOURCE_VERIFIED",
            status: "SUCCESS",
            severity: "INFO",
            decisionId: auditDecisionId,
            summary: "Airbnb callback channel reference verified and persisted",
            reason: "CALLBACK_RESOURCE_ONLY",
            metadata: {
              scope: "CALLBACK_RESOURCE_ONLY",
              channelId,
              requestedByUserId,
              lifecycleStatusChanged: false,
              activationChanged: false,
            },
            startedAt: now,
            completedAt: now,
            durationMs: 0,
          },
        });
      }, { isolationLevel: "Serializable" });
      return;
    } catch (error) {
      if (error instanceof AirbnbHostSelfServiceError) throw error;
      if (isRetryableLocalConflict(error) && retry < MAX_LOCAL_RETRIES) continue;
      const code =
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : null;
      if (code === "P2002") {
        throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_CHANNEL_CONFLICT");
      }
      throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_PERSISTENCE_FAILED");
    }
  }
}

/** Provider verification runs exactly once; only local persistence can retry. */
export async function verifyAndPersistAirbnbHostCallback(args: {
  verify: () => ReturnType<typeof verifyAirbnbHostCallback>;
  client: AirbnbCallbackPersistenceClient;
  guard: AirbnbCallbackPersistenceGuard;
  organizationId: string;
  requestedByUserId: string;
  now?: Date;
}): ReturnType<typeof verifyAirbnbHostCallback> {
  const result = await args.verify();
  if (!result.success) return result;
  if (!result.propertyId || !result.channelId || result.propertyId !== args.guard.propertyId) {
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_RESULT_INVALID");
  }
  await persistVerifiedAirbnbCallback({
    client: args.client,
    guard: args.guard,
    organizationId: args.organizationId,
    propertyId: result.propertyId,
    requestedByUserId: args.requestedByUserId,
    channelId: result.channelId,
    now: args.now,
  });
  return result;
}
