import { createHash } from "node:crypto";

import {
  AirbnbHostSelfServiceError,
  verifyAirbnbHostCallback,
} from "./airbnb-host-self-service.service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LOCAL_RETRIES = 2;

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
  $transaction<T>(
    work: (tx: AirbnbCallbackPersistenceTransaction) => Promise<T>,
    options?: { isolationLevel?: "Serializable" }
  ): Promise<T>;
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
  const now = args.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_CLOCK_INVALID");
  }

  for (let retry = 0; retry <= MAX_LOCAL_RETRIES; retry += 1) {
    try {
      await args.client.$transaction(async (tx) => {
        const connection = await tx.otaChannelConnection.findFirst({
          where: { organizationId, propertyId, provider: "AIRBNB" },
          select: {
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
                platform: true,
                provisioningStatus: true,
              },
            },
          },
        });
        const distributionProperty = connection?.distributionProperty;
        if (!connection || !distributionProperty) {
          throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_LOCAL_CONNECTION_NOT_FOUND");
        }
        if (
          connection.organizationId !== organizationId ||
          connection.propertyId !== propertyId ||
          connection.provider !== "AIRBNB" ||
          connection.distributionPropertyId !== distributionProperty.id ||
          distributionProperty.organizationId !== organizationId ||
          distributionProperty.propertyId !== propertyId ||
          distributionProperty.platform !== "CHANNEX" ||
          distributionProperty.provisioningStatus !== "READY"
        ) {
          throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_LOCAL_SCOPE_MISMATCH");
        }
        if (
          connection.externalConnectionId &&
          connection.externalConnectionId !== channelId
        ) {
          throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_CHANNEL_CONFLICT");
        }

        const auditDecisionId = decisionId(connection.id, channelId);
        const existingAudit = await tx.apmsAuditEntry.findUnique({
          where: { decisionId: auditDecisionId },
        });
        if (existingAudit) {
          validateExistingAudit({
            audit: existingAudit,
            organizationId,
            propertyId,
            connectionId: connection.id,
            channelId,
          });
          if (connection.externalConnectionId !== channelId) {
            throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_PERSISTENCE_CONFLICT");
          }
          return;
        }

        if (connection.externalConnectionId === null) {
          const updated = await tx.otaChannelConnection.updateMany({
            where: {
              id: connection.id,
              organizationId,
              propertyId,
              distributionPropertyId: distributionProperty.id,
              provider: "AIRBNB",
              externalConnectionId: null,
              status: connection.status,
              readinessRevision: connection.readinessRevision,
              updatedAt: connection.updatedAt,
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
            entityId: connection.id,
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

/** Provider verification is executed exactly once; local persistence may retry locally. */
export async function verifyAndPersistAirbnbHostCallback(args: {
  verify: () => ReturnType<typeof verifyAirbnbHostCallback>;
  client: AirbnbCallbackPersistenceClient;
  organizationId: string;
  requestedByUserId: string;
  now?: Date;
}): ReturnType<typeof verifyAirbnbHostCallback> {
  const result = await args.verify();
  if (!result.success) return result;
  if (!result.propertyId || !result.channelId) {
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_RESULT_INVALID");
  }
  await persistVerifiedAirbnbCallback({
    client: args.client,
    organizationId: args.organizationId,
    propertyId: result.propertyId,
    requestedByUserId: args.requestedByUserId,
    channelId: result.channelId,
    now: args.now,
  });
  return result;
}
