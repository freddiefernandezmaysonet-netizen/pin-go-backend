import type {
  OtaProvisioningRepository,
  ProvisioningSnapshot,
} from "./ota-connection-orchestrator.service.js";
import type { ProvisionedPropertyInventory } from "./channex-white-label.adapter.js";

type ProvisioningPrismaClient = {
  distributionProperty: {
    findFirst(args: any): Promise<any>;
    updateMany(args: any): Promise<{ count: number }>;
  };
  distributionGroup: {
    updateMany(args: any): Promise<{ count: number }>;
  };
  pmsListing: {
    findMany(args: any): Promise<any[]>;
    findUnique(args: any): Promise<any>;
    create(args: any): Promise<any>;
    updateMany(args: any): Promise<{ count: number }>;
  };
  pmsConnection: {
    findUnique(args: any): Promise<any>;
    create(args: any): Promise<any>;
  };
  apmsAuditEntry: {
    create(args: any): Promise<any>;
  };
  $transaction<T>(
    work: (tx: ProvisioningPrismaClient) => Promise<T>,
    options?: { isolationLevel?: "Serializable" }
  ): Promise<T>;
};

export class OtaProvisioningRepositoryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OtaProvisioningRepositoryError";
  }
}

function requireCurrency(value: string): string {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new OtaProvisioningRepositoryError("OTA_DEFAULT_CURRENCY_INVALID");
  }
  return normalized;
}

function requireUpdate(result: { count: number }, code: string): void {
  if (result.count !== 1) throw new OtaProvisioningRepositoryError(code);
}

function requireText(value: unknown, code: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new OtaProvisioningRepositoryError(code);
  return normalized;
}

function requireMetadata(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new OtaProvisioningRepositoryError(
      "OTA_CERTIFIED_PMS_LISTING_METADATA_INVALID"
    );
  }
  return value as Record<string, unknown>;
}

export class PrismaOtaProvisioningRepository implements OtaProvisioningRepository {
  private readonly currency: string;

  constructor(
    private readonly client: ProvisioningPrismaClient,
    defaultCurrency: string
  ) {
    this.currency = requireCurrency(defaultCurrency);
  }

  async alignPmsListingToReadyDistributionMapping(
    organizationId: string,
    propertyId: string,
    requestedByUserId: string,
    now: Date,
    options: { createIfMissing: boolean } = { createIfMissing: false }
  ): Promise<"CREATED" | "ALIGNED" | "ALREADY_ALIGNED"> {
    const actorId = requireText(requestedByUserId, "OTA_REQUESTED_BY_USER_ID_REQUIRED");
    return this.client.$transaction(async (tx) => {
      const distributionProperty = await tx.distributionProperty.findFirst({
        where: { organizationId, propertyId, platform: "CHANNEX" },
        select: {
          id: true,
          organizationId: true,
          propertyId: true,
          platform: true,
          provisioningStatus: true,
          externalPropertyId: true,
          externalPrimaryRoomTypeId: true,
          externalPrimaryRatePlanId: true,
          updatedAt: true,
          property: { select: { id: true, organizationId: true, name: true } },
          group: {
            select: {
              id: true,
              organizationId: true,
              platform: true,
              provisioningStatus: true,
              externalGroupId: true,
            },
          },
        },
      });
      if (!distributionProperty) {
        throw new OtaProvisioningRepositoryError(
          "OTA_DISTRIBUTION_PROPERTY_NOT_FOUND"
        );
      }
      if (
        distributionProperty.organizationId !== organizationId ||
        distributionProperty.propertyId !== propertyId ||
        distributionProperty.platform !== "CHANNEX" ||
        !distributionProperty.property ||
        distributionProperty.property.id !== propertyId ||
        distributionProperty.property.organizationId !== organizationId ||
        !distributionProperty.group ||
        distributionProperty.group.organizationId !== organizationId ||
        distributionProperty.group.platform !== "CHANNEX"
      ) {
        throw new OtaProvisioningRepositoryError(
          "OTA_DISTRIBUTION_TENANT_MISMATCH"
        );
      }
      if (
        distributionProperty.group.provisioningStatus !== "READY" ||
        !requireText(
          distributionProperty.group.externalGroupId,
          "OTA_CERTIFIED_MAPPING_GROUP_NOT_READY"
        )
      ) {
        throw new OtaProvisioningRepositoryError(
          "OTA_CERTIFIED_MAPPING_GROUP_NOT_READY"
        );
      }
      if (distributionProperty.provisioningStatus !== "READY") {
        throw new OtaProvisioningRepositoryError(
          "OTA_DISTRIBUTION_MAPPING_NOT_READY"
        );
      }
      const canonicalInventory = {
        externalPropertyId: requireText(
          distributionProperty.externalPropertyId,
          "OTA_DISTRIBUTION_PROPERTY_ID_REQUIRED"
        ),
        externalPrimaryRoomTypeId: requireText(
          distributionProperty.externalPrimaryRoomTypeId,
          "OTA_DISTRIBUTION_ROOM_TYPE_ID_REQUIRED"
        ),
        externalPrimaryRatePlanId: requireText(
          distributionProperty.externalPrimaryRatePlanId,
          "OTA_DISTRIBUTION_RATE_PLAN_ID_REQUIRED"
        ),
      };

      const listings = await tx.pmsListing.findMany({
        where: { propertyId, connection: { provider: "CHANNEX" } },
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
            },
          },
        },
      });
      // Only canonical onboarding may create a missing link. The existing
      // alignment-only entry point still rejects zero listings by default.
      if (listings.length === 0 && options.createIfMissing) {
        let connection = await tx.pmsConnection.findUnique({
          where: { organizationId_provider: { organizationId, provider: "CHANNEX" } },
          select: { id: true, organizationId: true, provider: true, status: true },
        });
        if (!connection) {
          connection = await tx.pmsConnection.create({
            data: {
              organizationId,
              provider: "CHANNEX",
              status: "ACTIVE",
              metadata: {
                connectionType: "WHITE_LABEL_GLOBAL",
                managedBy: "PinGo",
                createdBy: "ota-provisioning.repository",
                createdAt: now.toISOString(),
              },
            },
            select: { id: true, organizationId: true, provider: true, status: true },
          });
        }
        if (
          !connection?.id || connection.organizationId !== organizationId ||
          connection.provider !== "CHANNEX"
        ) {
          throw new OtaProvisioningRepositoryError("OTA_DISTRIBUTION_TENANT_MISMATCH");
        }
        if (connection.status !== "ACTIVE") {
          throw new OtaProvisioningRepositoryError("OTA_CERTIFIED_PMS_CONNECTION_NOT_ACTIVE");
        }
        const occupiedRoom = await tx.pmsListing.findUnique({
          where: {
            connectionId_externalListingId: {
              connectionId: connection.id,
              externalListingId: canonicalInventory.externalPrimaryRoomTypeId,
            },
          },
          select: { id: true },
        });
        if (occupiedRoom) {
          throw new OtaProvisioningRepositoryError("OTA_PMS_MAPPING_ROOM_ALREADY_LINKED");
        }
        const created = await tx.pmsListing.create({
          data: {
            connectionId: connection.id,
            propertyId,
            externalListingId: canonicalInventory.externalPrimaryRoomTypeId,
            name: distributionProperty.property.name,
            metadata: {
              provider: "CHANNEX",
              channexPropertyId: canonicalInventory.externalPropertyId,
              channexRatePlanId: canonicalInventory.externalPrimaryRatePlanId,
              provisionedAt: now.toISOString(),
            },
          },
          select: { id: true },
        });
        await tx.apmsAuditEntry.create({
          data: {
            organizationId,
            propertyId,
            entityType: "PMS_LISTING",
            entityId: created.id,
            engine: "OTA_DISTRIBUTION",
            eventType: "PMS_LISTING_CREATED_FROM_DISTRIBUTION_MAPPING",
            status: "SUCCESS",
            severity: "INFO",
            completedAt: now,
            decisionId: `ota-pms-mapping-creation:v1:${distributionProperty.id}:${created.id}`,
            summary: "Connection Center created the PMS listing from the ready distribution mapping",
            reason: "CANONICAL_PROVISIONING_PMS_LINK_REQUIRED",
            metadata: {
              requestedByUserId: actorId,
              pmsConnectionId: connection.id,
              pmsListingId: created.id,
              canonical: canonicalInventory,
            },
          },
        });
        return "CREATED";
      }
      if (listings.length !== 1) {
        throw new OtaProvisioningRepositoryError(
          "OTA_CERTIFIED_PMS_LISTING_CARDINALITY_INVALID"
        );
      }
      const listing = listings[0]!;
      if (
        listing.propertyId !== propertyId ||
        listing.connectionId !== listing.connection?.id ||
        listing.connection?.organizationId !== organizationId ||
        listing.connection?.provider !== "CHANNEX"
      ) {
        throw new OtaProvisioningRepositoryError(
          "OTA_DISTRIBUTION_TENANT_MISMATCH"
        );
      }
      if (listing.connection.status !== "ACTIVE") {
        throw new OtaProvisioningRepositoryError(
          "OTA_CERTIFIED_PMS_CONNECTION_NOT_ACTIVE"
        );
      }

      const metadata = requireMetadata(listing.metadata);
      if (metadata.provider !== "CHANNEX") {
        throw new OtaProvisioningRepositoryError(
          "OTA_CERTIFIED_PMS_LISTING_PROVIDER_INVALID"
        );
      }
      const alreadyAligned =
        listing.externalListingId ===
          canonicalInventory.externalPrimaryRoomTypeId &&
        metadata.channexPropertyId === canonicalInventory.externalPropertyId &&
        metadata.channexRatePlanId ===
          canonicalInventory.externalPrimaryRatePlanId;
      if (alreadyAligned) return "ALREADY_ALIGNED";

      requireUpdate(
        await tx.pmsListing.updateMany({
          where: {
            id: listing.id,
            connectionId: listing.connectionId,
            propertyId,
            externalListingId: listing.externalListingId,
            updatedAt: listing.updatedAt,
            connection: {
              organizationId,
              provider: "CHANNEX",
              status: "ACTIVE",
            },
          },
          data: {
            externalListingId:
              canonicalInventory.externalPrimaryRoomTypeId,
            metadata: {
              ...metadata,
              provider: "CHANNEX",
              channexPropertyId: canonicalInventory.externalPropertyId,
              channexRatePlanId:
                canonicalInventory.externalPrimaryRatePlanId,
            },
          },
        }),
        "OTA_PMS_MAPPING_ALIGNMENT_CONFLICT"
      );
      await tx.apmsAuditEntry.create({
        data: {
          organizationId,
          propertyId,
          entityType: "PMS_LISTING",
          entityId: listing.id,
          engine: "OTA_DISTRIBUTION",
          eventType: "PMS_LISTING_ALIGNED_TO_DISTRIBUTION_MAPPING",
          status: "SUCCESS",
          severity: "INFO",
          completedAt: now,
          decisionId:
            `ota-pms-mapping-alignment:v1:${distributionProperty.id}:` +
            `${listing.id}:${listing.updatedAt.toISOString()}`,
          summary: "Connection Center aligned the PMS listing to the ready distribution mapping",
          reason: "READY_DISTRIBUTION_MAPPING_IS_SOURCE_OF_TRUTH",
          metadata: {
            requestedByUserId: actorId,
            pmsConnectionId: listing.connectionId,
            pmsListingId: listing.id,
            previous: {
              externalPropertyId: metadata.channexPropertyId ?? null,
              externalPrimaryRoomTypeId: listing.externalListingId,
              externalPrimaryRatePlanId: metadata.channexRatePlanId ?? null,
            },
            canonical: canonicalInventory,
          },
        },
      });
      return "ALIGNED";
    }, { isolationLevel: "Serializable" });
  }

  async loadTenantSnapshot(
    organizationId: string,
    propertyId: string
  ): Promise<ProvisioningSnapshot | null> {
    const record = await this.client.distributionProperty.findFirst({
      where: { organizationId, propertyId, platform: "CHANNEX" },
      select: {
        id: true,
        organizationId: true,
        propertyId: true,
        provisioningStatus: true,
        lastErrorCode: true,
        externalPropertyId: true,
        externalPrimaryRoomTypeId: true,
        externalPrimaryRatePlanId: true,
        organization: { select: { name: true } },
        property: { select: { name: true, timezone: true, maxGuests: true } },
        group: {
          select: {
            id: true,
            organizationId: true,
            provisioningStatus: true,
            lastErrorCode: true,
            externalGroupId: true,
          },
        },
      },
    });
    if (!record) return null;
    if (
      record.organizationId !== organizationId ||
      record.propertyId !== propertyId ||
      !record.group ||
      record.group.organizationId !== organizationId
    ) {
      throw new OtaProvisioningRepositoryError("OTA_DISTRIBUTION_TENANT_MISMATCH");
    }
    const timezone = String(record.property?.timezone ?? "").trim();
    if (!timezone) {
      throw new OtaProvisioningRepositoryError("OTA_PROPERTY_TIMEZONE_REQUIRED");
    }
    return {
      organizationId,
      organizationName: String(record.organization?.name ?? "").trim(),
      propertyId,
      propertyName: String(record.property?.name ?? "").trim(),
      maxGuests: Number(record.property?.maxGuests),
      currency: this.currency,
      timezone,
      groupId: record.group.id,
      distributionPropertyId: record.id,
      groupStatus: record.group.provisioningStatus,
      propertyStatus: record.provisioningStatus,
      groupLastErrorCode: record.group.lastErrorCode,
      propertyLastErrorCode: record.lastErrorCode,
      externalGroupId: record.group.externalGroupId,
      externalPropertyId: record.externalPropertyId,
      externalPrimaryRoomTypeId: record.externalPrimaryRoomTypeId,
      externalPrimaryRatePlanId: record.externalPrimaryRatePlanId,
    };
  }

  async claimGroup(organizationId: string, groupId: string): Promise<boolean> {
    const result = await this.client.distributionGroup.updateMany({
      where: {
        id: groupId,
        organizationId,
        platform: "CHANNEX",
        provisioningStatus: { in: ["NOT_PROVISIONED", "FAILED"] },
      },
      data: { provisioningStatus: "PROVISIONING", lastErrorCode: null, lastErrorSummary: null },
    });
    return result.count === 1;
  }

  async completeGroup(
    organizationId: string,
    groupId: string,
    externalGroupId: string,
    now: Date
  ): Promise<void> {
    requireUpdate(await this.client.distributionGroup.updateMany({
      where: { id: groupId, organizationId, platform: "CHANNEX", provisioningStatus: "PROVISIONING" },
      data: { externalGroupId, provisioningStatus: "READY", provisionedAt: now, verifiedAt: now, lastErrorCode: null, lastErrorSummary: null },
    }), "OTA_GROUP_PROVISIONING_STATE_CONFLICT");
  }

  async failGroup(organizationId: string, groupId: string, errorCode: string): Promise<void> {
    requireUpdate(await this.client.distributionGroup.updateMany({
      where: { id: groupId, organizationId, platform: "CHANNEX", provisioningStatus: "PROVISIONING" },
      data: { provisioningStatus: "FAILED", lastErrorCode: errorCode, lastErrorSummary: null },
    }), "OTA_GROUP_PROVISIONING_STATE_CONFLICT");
  }

  async claimProperty(organizationId: string, distributionPropertyId: string): Promise<boolean> {
    const result = await this.client.distributionProperty.updateMany({
      where: {
        id: distributionPropertyId,
        organizationId,
        platform: "CHANNEX",
        provisioningStatus: { in: ["NOT_PROVISIONED", "FAILED"] },
      },
      data: { provisioningStatus: "PROVISIONING", lastErrorCode: null, lastErrorSummary: null },
    });
    return result.count === 1;
  }

  async checkpointProperty(
    organizationId: string,
    distributionPropertyId: string,
    externalPropertyId: string
  ): Promise<void> {
    requireUpdate(await this.client.distributionProperty.updateMany({
      where: { id: distributionPropertyId, organizationId, platform: "CHANNEX", provisioningStatus: "PROVISIONING" },
      data: { externalPropertyId },
    }), "OTA_PROPERTY_PROVISIONING_STATE_CONFLICT");
  }

  async checkpointPrimaryRoomType(
    organizationId: string,
    distributionPropertyId: string,
    externalPrimaryRoomTypeId: string
  ): Promise<void> {
    requireUpdate(await this.client.distributionProperty.updateMany({
      where: { id: distributionPropertyId, organizationId, platform: "CHANNEX", provisioningStatus: "PROVISIONING" },
      data: { externalPrimaryRoomTypeId },
    }), "OTA_PROPERTY_PROVISIONING_STATE_CONFLICT");
  }

  async completeProperty(
    organizationId: string,
    distributionPropertyId: string,
    inventory: ProvisionedPropertyInventory,
    now: Date
  ): Promise<void> {
    requireUpdate(await this.client.distributionProperty.updateMany({
      where: { id: distributionPropertyId, organizationId, platform: "CHANNEX", provisioningStatus: "PROVISIONING" },
      data: {
        ...inventory,
        provisioningStatus: "READY",
        provisionedAt: now,
        verifiedAt: now,
        lastErrorCode: null,
        lastErrorSummary: null,
      },
    }), "OTA_PROPERTY_PROVISIONING_STATE_CONFLICT");
  }

  async failProperty(
    organizationId: string,
    distributionPropertyId: string,
    errorCode: string
  ): Promise<void> {
    requireUpdate(await this.client.distributionProperty.updateMany({
      where: { id: distributionPropertyId, organizationId, platform: "CHANNEX", provisioningStatus: "PROVISIONING" },
      data: { provisioningStatus: "FAILED", lastErrorCode: errorCode, lastErrorSummary: null },
    }), "OTA_PROPERTY_PROVISIONING_STATE_CONFLICT");
  }
}
