import { createHash } from "node:crypto";

import type { ConnectionCenterProvider } from "./connection-center.read-model.js";

type DistributionPlatform = "CHANNEX";

type DistributionGroupRecord = {
  id: string;
  organizationId: string;
  platform: DistributionPlatform;
};

type DistributionPropertyRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  groupId: string | null;
  platform: DistributionPlatform;
};

export type OtaChannelConnectionRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  distributionPropertyId: string;
  provider: ConnectionCenterProvider;
  status: string;
};

type DistributionTransaction = {
  distributionGroup: {
    upsert(args: any): Promise<DistributionGroupRecord>;
  };
  distributionProperty: {
    findUnique(args: any): Promise<DistributionPropertyRecord | null>;
    create(args: any): Promise<DistributionPropertyRecord>;
  };
  otaChannelConnection: {
    findUnique(args: any): Promise<OtaChannelConnectionRecord | null>;
    create(args: any): Promise<OtaChannelConnectionRecord>;
  };
  apmsAuditEntry: {
    findUnique(args: any): Promise<{ id: string } | null>;
    create(args: any): Promise<unknown>;
  };
};

export type OtaDistributionPersistenceClient = {
  dashboardUser: {
    findFirst(args: any): Promise<{ id: string } | null>;
  };
  property: {
    findFirst(args: any): Promise<{ id: string; organizationId: string } | null>;
  };
  $transaction<T>(work: (tx: DistributionTransaction) => Promise<T>): Promise<T>;
};

const SELF_SERVICE_PROVIDERS = new Set<ConnectionCenterProvider>([
  "AIRBNB",
  "BOOKING_COM",
]);

export class OtaDistributionPersistenceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OtaDistributionPersistenceError";
  }
}

function requiredId(value: string, code: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 120) {
    throw new OtaDistributionPersistenceError(code);
  }
  return normalized;
}

function requestDecisionId(organizationId: string, requestKey: string): string {
  const digest = createHash("sha256")
    .update(`${organizationId}:${requestKey}`)
    .digest("hex");
  return `ota-distribution-prepare:${digest}`;
}

function assertSelfServiceProvider(provider: ConnectionCenterProvider): void {
  if (SELF_SERVICE_PROVIDERS.has(provider)) return;
  const suffix = provider === "VRBO" ? "ASSISTED_BETA" : "PLANNED";
  throw new OtaDistributionPersistenceError(
    `OTA_PROVIDER_SELF_SERVICE_UNAVAILABLE:${provider}:${suffix}`
  );
}

export async function prepareOtaDistributionConnection(args: {
  client: OtaDistributionPersistenceClient;
  organizationId: string;
  propertyId: string;
  requestedByUserId: string;
  provider: ConnectionCenterProvider;
  requestKey: string;
  now?: Date;
}): Promise<OtaChannelConnectionRecord> {
  const organizationId = requiredId(
    args.organizationId,
    "OTA_DISTRIBUTION_ORGANIZATION_REQUIRED"
  );
  const propertyId = requiredId(args.propertyId, "OTA_DISTRIBUTION_PROPERTY_REQUIRED");
  const requestedByUserId = requiredId(
    args.requestedByUserId,
    "OTA_DISTRIBUTION_ACTOR_REQUIRED"
  );
  const requestKey = requiredId(args.requestKey, "OTA_DISTRIBUTION_REQUEST_KEY_INVALID");
  if (!/^[A-Za-z0-9._:-]+$/.test(requestKey)) {
    throw new OtaDistributionPersistenceError("OTA_DISTRIBUTION_REQUEST_KEY_INVALID");
  }
  assertSelfServiceProvider(args.provider);

  const [actor, property] = await Promise.all([
    args.client.dashboardUser.findFirst({
      where: { id: requestedByUserId, organizationId, isActive: true },
      select: { id: true },
    }),
    args.client.property.findFirst({
      where: { id: propertyId, organizationId, status: "ACTIVE" },
      select: { id: true, organizationId: true },
    }),
  ]);

  if (!actor) throw new OtaDistributionPersistenceError("OTA_DISTRIBUTION_ACTOR_FORBIDDEN");
  if (!property) {
    throw new OtaDistributionPersistenceError("OTA_DISTRIBUTION_PROPERTY_NOT_FOUND");
  }

  return args.client.$transaction(async (tx) => {
    const group = await tx.distributionGroup.upsert({
      where: {
        organizationId_platform: { organizationId, platform: "CHANNEX" },
      },
      create: { organizationId, platform: "CHANNEX" },
      update: {},
    });
    if (group.organizationId !== organizationId || group.platform !== "CHANNEX") {
      throw new OtaDistributionPersistenceError("OTA_DISTRIBUTION_TENANT_MISMATCH");
    }

    let distributionProperty = await tx.distributionProperty.findUnique({
      where: { propertyId_platform: { propertyId, platform: "CHANNEX" } },
    });
    if (!distributionProperty) {
      distributionProperty = await tx.distributionProperty.create({
        data: {
          organizationId,
          propertyId,
          groupId: group.id,
          platform: "CHANNEX",
        },
      });
    }
    if (
      distributionProperty.organizationId !== organizationId ||
      distributionProperty.propertyId !== propertyId ||
      distributionProperty.groupId !== group.id ||
      distributionProperty.platform !== "CHANNEX"
    ) {
      throw new OtaDistributionPersistenceError("OTA_DISTRIBUTION_TENANT_MISMATCH");
    }

    let connection = await tx.otaChannelConnection.findUnique({
      where: { propertyId_provider: { propertyId, provider: args.provider } },
    });
    if (!connection) {
      connection = await tx.otaChannelConnection.create({
        data: {
          organizationId,
          propertyId,
          distributionPropertyId: distributionProperty.id,
          provider: args.provider,
          status: "NOT_CONNECTED",
        },
      });
    }
    if (
      connection.organizationId !== organizationId ||
      connection.propertyId !== propertyId ||
      connection.distributionPropertyId !== distributionProperty.id ||
      connection.provider !== args.provider
    ) {
      throw new OtaDistributionPersistenceError("OTA_DISTRIBUTION_TENANT_MISMATCH");
    }

    const decisionId = requestDecisionId(organizationId, requestKey);
    const existingAudit = await tx.apmsAuditEntry.findUnique({ where: { decisionId } });
    if (!existingAudit) {
      const now = args.now ?? new Date();
      await tx.apmsAuditEntry.create({
        data: {
          organizationId,
          propertyId,
          entityType: "DISTRIBUTION",
          entityId: connection.id,
          engine: "OTA_DISTRIBUTION",
          eventType: "DECISION_APPLIED",
          status: "SUCCESS",
          severity: "INFO",
          decisionId,
          summary: "OTA distribution connection prepared",
          reason: "FIRST_OTA_CONNECTION_REQUEST",
          metadata: {
            provider: args.provider,
            requestedByUserId,
            provisioningTriggered: false,
          },
          startedAt: now,
          completedAt: now,
          durationMs: 0,
        },
      });
    }

    return connection;
  });
}
