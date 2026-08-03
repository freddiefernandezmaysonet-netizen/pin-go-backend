import type { Prisma } from "@prisma/client";

import {
  validateV1Mapping,
} from "./channex-ari-lifecycle.policy";
import type { ChannexAriDeliveryMapping } from "./channex-ari-delivery.service";

export type ChannexAriMappingDb = Pick<
  Prisma.TransactionClient,
  "property" | "pmsConnection" | "pmsListing"
>;

export type ResolveChannexAriMappingInput = {
  organizationId: string;
  propertyId: string;
};

type UnknownRecord = Record<string, unknown>;

function requireText(value: unknown, errorCode: string): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(errorCode);
  }

  return normalized;
}

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

export async function resolveChannexAriMapping(
  db: ChannexAriMappingDb,
  input: ResolveChannexAriMappingInput
): Promise<ChannexAriDeliveryMapping> {
  const organizationId = requireText(
    input.organizationId,
    "CHANNEX_ARI_ORGANIZATION_ID_REQUIRED"
  );
  const propertyId = requireText(
    input.propertyId,
    "CHANNEX_ARI_PROPERTY_ID_REQUIRED"
  );
  const property = await db.property.findFirst({
    where: {
      id: propertyId,
      organizationId,
    },
    select: {
      id: true,
      organizationId: true,
      status: true,
      distributionEnabled: true,
      distributionStatus: true,
    },
  });

  if (!property) {
    throw new Error("CHANNEX_ARI_PROPERTY_NOT_FOUND");
  }

  if (property.status !== "ACTIVE") {
    throw new Error("CHANNEX_ARI_PROPERTY_NOT_ACTIVE");
  }

  if (!property.distributionEnabled || property.distributionStatus !== "ACTIVE") {
    throw new Error("CHANNEX_ARI_PROPERTY_DISTRIBUTION_NOT_ACTIVE");
  }

  const connection = await db.pmsConnection.findUnique({
    where: {
      organizationId_provider: {
        organizationId,
        provider: "CHANNEX",
      },
    },
    select: {
      id: true,
      organizationId: true,
      provider: true,
      status: true,
    },
  });

  if (!connection) {
    throw new Error("CHANNEX_ARI_CONNECTION_NOT_FOUND");
  }

  if (
    connection.organizationId !== organizationId ||
    connection.provider !== "CHANNEX"
  ) {
    throw new Error("CHANNEX_ARI_CONNECTION_TENANT_MISMATCH");
  }

  if (connection.status !== "ACTIVE") {
    throw new Error("CHANNEX_ARI_CONNECTION_NOT_ACTIVE");
  }

  const listings = await db.pmsListing.findMany({
    where: {
      connectionId: connection.id,
      propertyId,
    },
    orderBy: { id: "asc" },
    take: 2,
    select: {
      id: true,
      connectionId: true,
      propertyId: true,
      externalListingId: true,
      metadata: true,
    },
  });

  if (listings.length === 0) {
    throw new Error("CHANNEX_ARI_LISTING_MAPPING_MISSING");
  }

  if (listings.length !== 1) {
    throw new Error("CHANNEX_ARI_LISTING_MAPPING_CARDINALITY_INVALID");
  }

  const listing = listings[0];

  if (
    listing.connectionId !== connection.id ||
    listing.propertyId !== propertyId
  ) {
    throw new Error("CHANNEX_ARI_LISTING_TENANT_MISMATCH");
  }

  const metadata = asRecord(listing.metadata);

  if (!metadata) {
    throw new Error("CHANNEX_ARI_LISTING_METADATA_INVALID");
  }

  if (requireText(metadata.provider, "CHANNEX_ARI_LISTING_PROVIDER_REQUIRED") !== "CHANNEX") {
    throw new Error("CHANNEX_ARI_LISTING_PROVIDER_MISMATCH");
  }

  const mapping: ChannexAriDeliveryMapping = {
    connectionId: connection.id,
    listingId: listing.id,
    connectionProvider: connection.provider,
    connectionOrganizationId: connection.organizationId,
    propertyOrganizationId: property.organizationId,
    propertyId: property.id,
    externalRoomTypeId: requireText(
      listing.externalListingId,
      "CHANNEX_ARI_ROOM_TYPE_MAPPING_MISSING"
    ),
    channexPropertyId: requireText(
      metadata.channexPropertyId,
      "CHANNEX_ARI_CHANNEX_PROPERTY_MAPPING_MISSING"
    ),
    channexRatePlanId: requireText(
      metadata.channexRatePlanId,
      "CHANNEX_ARI_RATE_PLAN_MAPPING_MISSING"
    ),
  };
  const validation = validateV1Mapping({
    connectionProvider: mapping.connectionProvider,
    connectionOrganizationId: mapping.connectionOrganizationId,
    propertyOrganizationId: mapping.propertyOrganizationId,
    propertyId: mapping.propertyId,
    externalRoomTypeId: mapping.externalRoomTypeId,
    channexPropertyId: mapping.channexPropertyId,
    channexRatePlanId: mapping.channexRatePlanId,
  });

  if (!validation.ok) {
    throw new Error(validation.reason);
  }

  return mapping;
}
