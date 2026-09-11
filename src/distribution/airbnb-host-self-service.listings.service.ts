import { AirbnbHostSelfServiceError } from "./airbnb-host-self-service.service.js";

export type AirbnbListingSummary = {
  id: string;
  title: string | null;
  type: string | null;
  occupancies: number[] | null;
  synchronizationCategory: string | null;
  city: string | null;
  countryCode: string | null;
  qualityStatus: string | null;
};

export type AirbnbListingDiscoveryClient = {
  otaChannelConnection: {
    findFirst(args: unknown): Promise<{
      organizationId: string;
      propertyId: string;
      provider: string;
      externalConnectionId: string | null;
    } | null>;
  };
};

export type AirbnbListingDiscoveryTransport = {
  listAirbnbListings(channelId: string): Promise<unknown>;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function required(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AirbnbHostSelfServiceError(code);
  }
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalOccupancies(value: unknown): number[] | null {
  if (value == null) return null;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "number" || !Number.isInteger(item))
  ) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
    );
  }
  return [...value];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseAirbnbListingDiscoveryPayload(
  payload: unknown
): AirbnbListingSummary[] {
  const root = record(payload);
  const data = record(root?.data);
  const dictionary = record(data?.listing_id_dictionary);
  const values = dictionary?.values;
  if (!Array.isArray(values)) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
    );
  }

  return values.map((value) => {
    const listing = record(value);
    if (!listing) {
      throw new AirbnbHostSelfServiceError(
        "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
      );
    }
    return {
      id: required(
        listing.id,
        "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
      ),
      title: optionalText(listing.title),
      type: optionalText(listing.type),
      occupancies: optionalOccupancies(listing.occupancies),
      synchronizationCategory: optionalText(listing.synchronization_category),
      city: optionalText(listing.city),
      countryCode: optionalText(listing.country_code),
      qualityStatus: optionalText(listing.quality_status),
    };
  });
}

export async function discoverAirbnbListings(args: {
  client: AirbnbListingDiscoveryClient;
  transport: AirbnbListingDiscoveryTransport;
  organizationId: string;
  propertyId: string;
}): Promise<{
  channelId: string;
  listings: AirbnbListingSummary[];
}> {
  const organizationId = required(
    args.organizationId,
    "OTA_AIRBNB_TENANT_INVALID"
  );
  const propertyId = required(args.propertyId, "OTA_AIRBNB_PROPERTY_INVALID");

  const connection = await args.client.otaChannelConnection.findFirst({
    where: {
      organizationId,
      propertyId,
      provider: "AIRBNB",
    },
    select: {
      organizationId: true,
      propertyId: true,
      provider: true,
      externalConnectionId: true,
    },
  });

  if (!connection) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_CONNECTION_NOT_FOUND"
    );
  }
  if (
    connection.organizationId !== organizationId ||
    connection.propertyId !== propertyId ||
    connection.provider !== "AIRBNB"
  ) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_LISTING_DISCOVERY_SCOPE_MISMATCH"
    );
  }

  const channelId = required(
    connection.externalConnectionId,
    "OTA_AIRBNB_CHANNEL_ID_UNAVAILABLE"
  );
  if (!UUID.test(channelId)) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_CHANNEL_ID_INVALID"
    );
  }

  const payload = await args.transport.listAirbnbListings(channelId);
  return {
    channelId,
    listings: parseAirbnbListingDiscoveryPayload(payload),
  };
}
