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

export class PrismaOtaProvisioningRepository implements OtaProvisioningRepository {
  private readonly currency: string;

  constructor(
    private readonly client: ProvisioningPrismaClient,
    defaultCurrency: string
  ) {
    this.currency = requireCurrency(defaultCurrency);
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
        property: { select: { name: true, timezone: true } },
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
