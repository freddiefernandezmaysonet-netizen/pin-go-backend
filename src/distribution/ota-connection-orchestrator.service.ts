import type { ConnectionCenterProvider } from "./connection-center.read-model.js";
import type {
  ProvisionedPropertyInventory,
  WhiteLabelProvisioner,
} from "./channex-white-label.adapter.js";

export type ProvisioningSnapshot = {
  organizationId: string;
  organizationName: string;
  propertyId: string;
  propertyName: string;
  currency: string;
  timezone: string;
  groupId: string;
  distributionPropertyId: string;
  groupStatus: "NOT_PROVISIONED" | "PROVISIONING" | "READY" | "FAILED";
  propertyStatus: "NOT_PROVISIONED" | "PROVISIONING" | "READY" | "FAILED";
  groupLastErrorCode: string | null;
  propertyLastErrorCode: string | null;
  externalGroupId: string | null;
  externalPropertyId: string | null;
  externalPrimaryRoomTypeId: string | null;
  externalPrimaryRatePlanId: string | null;
};

export type OtaProvisioningRepository = {
  loadTenantSnapshot(organizationId: string, propertyId: string): Promise<ProvisioningSnapshot | null>;
  claimGroup(organizationId: string, groupId: string): Promise<boolean>;
  completeGroup(organizationId: string, groupId: string, externalGroupId: string, now: Date): Promise<void>;
  failGroup(organizationId: string, groupId: string, errorCode: string): Promise<void>;
  claimProperty(organizationId: string, distributionPropertyId: string): Promise<boolean>;
  checkpointProperty(
    organizationId: string,
    distributionPropertyId: string,
    externalPropertyId: string
  ): Promise<void>;
  checkpointPrimaryRoomType(
    organizationId: string,
    distributionPropertyId: string,
    externalPrimaryRoomTypeId: string
  ): Promise<void>;
  completeProperty(
    organizationId: string,
    distributionPropertyId: string,
    inventory: ProvisionedPropertyInventory,
    now: Date
  ): Promise<void>;
  failProperty(organizationId: string, distributionPropertyId: string, errorCode: string): Promise<void>;
};

export class OtaProvisioningError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OtaProvisioningError";
  }
}

function safeFailureCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    /^OTA_[A-Z0-9_:.-]{1,116}$/.test((error as { code: string }).code)
  ) {
    return (error as { code: string }).code;
  }
  return "OTA_PROVIDER_RECONCILIATION_REQUIRED";
}

export async function orchestrateOtaProvisioning(args: {
  repository: OtaProvisioningRepository;
  provisioner: WhiteLabelProvisioner;
  prepareLogicalConnection(input: {
    organizationId: string;
    propertyId: string;
    requestedByUserId: string;
    provider: ConnectionCenterProvider;
    requestKey: string;
  }): Promise<unknown>;
  organizationId: string;
  propertyId: string;
  requestedByUserId: string;
  provider: ConnectionCenterProvider;
  requestKey: string;
  now?: Date;
}): Promise<{ provisioningStatus: "READY" }> {
  await args.prepareLogicalConnection({
    organizationId: args.organizationId,
    propertyId: args.propertyId,
    requestedByUserId: args.requestedByUserId,
    provider: args.provider,
    requestKey: args.requestKey,
  });

  const snapshot = await args.repository.loadTenantSnapshot(
    args.organizationId,
    args.propertyId
  );
  if (
    !snapshot ||
    snapshot.organizationId !== args.organizationId ||
    snapshot.propertyId !== args.propertyId
  ) {
    throw new OtaProvisioningError("OTA_DISTRIBUTION_TENANT_MISMATCH");
  }
  if (snapshot.groupStatus === "READY" && snapshot.propertyStatus === "READY") {
    return { provisioningStatus: "READY" };
  }
  if (
    snapshot.groupStatus === "FAILED" &&
    snapshot.groupLastErrorCode === "OTA_PROVIDER_RECONCILIATION_REQUIRED"
  ) {
    throw new OtaProvisioningError("OTA_PROVIDER_RECONCILIATION_REQUIRED");
  }
  if (
    snapshot.propertyStatus === "FAILED" &&
    snapshot.propertyLastErrorCode === "OTA_PROVIDER_RECONCILIATION_REQUIRED"
  ) {
    throw new OtaProvisioningError("OTA_PROVIDER_RECONCILIATION_REQUIRED");
  }

  const now = args.now ?? new Date();
  let externalGroupId = snapshot.externalGroupId;
  if (snapshot.groupStatus !== "READY" || !externalGroupId) {
    if (!(await args.repository.claimGroup(args.organizationId, snapshot.groupId))) {
      throw new OtaProvisioningError("OTA_GROUP_PROVISIONING_CONFLICT");
    }
    try {
      const group = await args.provisioner.ensureGroup({
        organizationId: args.organizationId,
        organizationName: snapshot.organizationName,
        existingExternalGroupId: externalGroupId,
      });
      externalGroupId = group.externalGroupId;
      await args.repository.completeGroup(
        args.organizationId,
        snapshot.groupId,
        externalGroupId,
        now
      );
    } catch (error) {
      const code = safeFailureCode(error);
      await args.repository.failGroup(args.organizationId, snapshot.groupId, code);
      throw new OtaProvisioningError(code);
    }
  }

  if (
    snapshot.propertyStatus !== "READY" ||
    !snapshot.externalPropertyId ||
    !snapshot.externalPrimaryRoomTypeId ||
    !snapshot.externalPrimaryRatePlanId
  ) {
    if (!(await args.repository.claimProperty(args.organizationId, snapshot.distributionPropertyId))) {
      throw new OtaProvisioningError("OTA_PROPERTY_PROVISIONING_CONFLICT");
    }
    try {
      const property = await args.provisioner.ensureProperty({
        organizationId: args.organizationId,
        propertyId: args.propertyId,
        propertyName: snapshot.propertyName,
        currency: snapshot.currency,
        timezone: snapshot.timezone,
        externalGroupId,
        existingExternalPropertyId: snapshot.externalPropertyId,
      });
      await args.repository.checkpointProperty(
        args.organizationId,
        snapshot.distributionPropertyId,
        property.externalPropertyId
      );
      const room = await args.provisioner.ensurePrimaryRoomType({
        externalPropertyId: property.externalPropertyId,
        existingExternalPrimaryRoomTypeId: snapshot.externalPrimaryRoomTypeId,
      });
      await args.repository.checkpointPrimaryRoomType(
        args.organizationId,
        snapshot.distributionPropertyId,
        room.externalPrimaryRoomTypeId
      );
      const rate = await args.provisioner.ensurePrimaryRatePlan({
        externalPropertyId: property.externalPropertyId,
        externalPrimaryRoomTypeId: room.externalPrimaryRoomTypeId,
        currency: snapshot.currency,
        existingExternalPrimaryRatePlanId: snapshot.externalPrimaryRatePlanId,
      });
      const inventory: ProvisionedPropertyInventory = {
        externalPropertyId: property.externalPropertyId,
        externalPrimaryRoomTypeId: room.externalPrimaryRoomTypeId,
        externalPrimaryRatePlanId: rate.externalPrimaryRatePlanId,
      };
      await args.repository.completeProperty(
        args.organizationId,
        snapshot.distributionPropertyId,
        inventory,
        now
      );
    } catch (error) {
      const code = safeFailureCode(error);
      await args.repository.failProperty(
        args.organizationId,
        snapshot.distributionPropertyId,
        code
      );
      throw new OtaProvisioningError(code);
    }
  }

  return { provisioningStatus: "READY" };
}
