import {
  AirbnbCallbackChannelVerificationError,
  verifyAirbnbCallbackChannelResource,
} from "./airbnb-host-self-service.callback-verifier.js";
import type { AirbnbHostSelfServiceClient } from "./airbnb-host-self-service.service.js";

export class AirbnbHostListingsError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AirbnbHostListingsError";
  }
}

export type AirbnbHostListing = {
  id: string;
  title: string;
};

export type AirbnbHostListingsTransport = {
  getChannel(channelId: string): Promise<unknown>;
  listListings(channelId: string): Promise<unknown>;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AirbnbHostListingsError(code);
  }
  return value;
}

function requiredUuid(value: unknown, code: string): string {
  const result = requiredText(value, code);
  if (!UUID.test(result)) throw new AirbnbHostListingsError(code);
  return result;
}

function parseListings(payload: unknown): AirbnbHostListing[] {
  const root = record(payload);
  const data = record(root?.data);
  const dictionary = record(data?.listing_id_dictionary);
  if (!dictionary || !Array.isArray(dictionary.values)) {
    throw new AirbnbHostListingsError("OTA_AIRBNB_LISTINGS_RESPONSE_INVALID");
  }

  return dictionary.values.map((value) => {
    const listing = record(value);
    if (!listing) {
      throw new AirbnbHostListingsError("OTA_AIRBNB_LISTINGS_RESPONSE_INVALID");
    }
    return {
      id: requiredText(listing.id, "OTA_AIRBNB_LISTINGS_RESPONSE_INVALID"),
      title: requiredText(listing.title, "OTA_AIRBNB_LISTINGS_RESPONSE_INVALID"),
    };
  });
}

export async function discoverAirbnbHostListings(args: {
  client: AirbnbHostSelfServiceClient;
  transport: AirbnbHostListingsTransport;
  organizationId: string;
  propertyId: string;
  channelId: string;
}): Promise<{
  propertyId: string;
  channelId: string;
  airbnbAccountVerified: true;
  listings: AirbnbHostListing[];
  nextAction: "MAPPING_REQUIRED";
}> {
  const organizationId = requiredText(
    args.organizationId,
    "OTA_AIRBNB_TENANT_INVALID"
  );
  const propertyId = requiredText(args.propertyId, "OTA_AIRBNB_PROPERTY_INVALID");
  const channelId = requiredUuid(args.channelId, "OTA_AIRBNB_CHANNEL_ID_INVALID");

  const distributionProperty = await args.client.distributionProperty.findFirst({
    where: { organizationId, propertyId, platform: "CHANNEX" },
    select: {
      organizationId: true,
      propertyId: true,
      platform: true,
      provisioningStatus: true,
      externalPropertyId: true,
      externalPrimaryRoomTypeId: true,
      externalPrimaryRatePlanId: true,
      group: {
        select: {
          organizationId: true,
          platform: true,
          provisioningStatus: true,
          externalGroupId: true,
        },
      },
    },
  });
  if (!distributionProperty) {
    throw new AirbnbHostListingsError("OTA_AIRBNB_PROPERTY_NOT_PROVISIONED");
  }
  if (
    distributionProperty.organizationId !== organizationId ||
    distributionProperty.propertyId !== propertyId ||
    distributionProperty.platform !== "CHANNEX" ||
    distributionProperty.provisioningStatus !== "READY" ||
    !distributionProperty.group ||
    distributionProperty.group.organizationId !== organizationId ||
    distributionProperty.group.platform !== "CHANNEX" ||
    distributionProperty.group.provisioningStatus !== "READY"
  ) {
    throw new AirbnbHostListingsError("OTA_AIRBNB_PROVISIONING_NOT_READY");
  }

  const expectedPropertyId = requiredUuid(
    distributionProperty.externalPropertyId,
    "OTA_AIRBNB_EXTERNAL_PROPERTY_ID_INVALID"
  );
  const expectedGroupId = requiredUuid(
    distributionProperty.group.externalGroupId,
    "OTA_AIRBNB_EXTERNAL_GROUP_ID_INVALID"
  );

  try {
    verifyAirbnbCallbackChannelResource({
      payload: await args.transport.getChannel(channelId),
      expectedChannelId: channelId,
      expectedPropertyId,
      expectedGroupId,
    });
  } catch (error) {
    if (error instanceof AirbnbCallbackChannelVerificationError) {
      throw new AirbnbHostListingsError(error.code);
    }
    throw error;
  }

  // Channex documents this endpoint as Airbnb-specific; other channels receive
  // 400. A valid 200 listing dictionary is therefore the provider-specific gate.
  const listings = parseListings(await args.transport.listListings(channelId));

  return {
    propertyId,
    channelId,
    airbnbAccountVerified: true,
    listings,
    nextAction: "MAPPING_REQUIRED",
  };
}
