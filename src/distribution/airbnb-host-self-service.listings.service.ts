import { AirbnbHostSelfServiceError } from "./airbnb-host-self-service.service.js";
import {
  matchAirbnbPropertyPortfolio,
  type AirbnbPropertyMatchDecision,
  type AirbnbPropertyPortfolioMatch,
  type PinGoPropertyMatchInput,
} from "./airbnb-property-auto-matching.js";

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
  property: {
    findMany(args: unknown): Promise<PinGoPropertyMatchInput[]>;
  };
};

export type AirbnbListingDiscoveryTransport = {
  listAirbnbListings(channelId: string): Promise<unknown>;
};

export type AirbnbListingDiscoveryResult = {
  channelId: string;
  listings: AirbnbListingSummary[];
  match: AirbnbPropertyMatchDecision;
  portfolioSummary: AirbnbPropertyPortfolioMatch["summary"];
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
}): Promise<AirbnbListingDiscoveryResult> {
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

  const properties = await args.client.property.findMany({
    where: {
      organizationId,
      status: "ACTIVE",
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      name: true,
      publicTitle: true,
      city: true,
      country: true,
      maxGuests: true,
    },
  });
  if (!properties.some((property) => property.id === propertyId)) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_PROPERTY_NOT_FOUND"
    );
  }

  const payload = await args.transport.listAirbnbListings(channelId);
  const listings = parseAirbnbListingDiscoveryPayload(payload);
  const portfolio = matchAirbnbPropertyPortfolio({ properties, listings });
  const match = portfolio.decisions.find(
    (decision) => decision.propertyId === propertyId
  );
  if (!match) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_PROPERTY_MATCHING_FAILED"
    );
  }

  return {
    channelId,
    listings,
    match,
    portfolioSummary: portfolio.summary,
  };
}
