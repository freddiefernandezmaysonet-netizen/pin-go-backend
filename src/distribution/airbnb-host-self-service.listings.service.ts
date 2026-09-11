import { AirbnbHostSelfServiceError } from "./airbnb-host-self-service.service.js";
import {
  corroborateAirbnbPropertyMatch,
  matchAirbnbPropertyPortfolio,
  type AirbnbListingDetailsEvidence,
  type AirbnbPropertyMatchDecision,
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

type AirbnbListingDiscoveryPropertyRow = PinGoPropertyMatchInput & {
  region: string | null;
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
    findMany(args: unknown): Promise<AirbnbListingDiscoveryPropertyRow[]>;
  };
};

export type AirbnbListingDiscoveryTransport = {
  listAirbnbListings(channelId: string): Promise<unknown>;
  getAirbnbListingDetails(channelId: string, listingId: string): Promise<unknown>;
};

export type AirbnbListingDiscoveryResult = {
  channelId: string;
  listings: AirbnbListingSummary[];
  match: AirbnbPropertyMatchDecision;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const UNITED_STATES_COUNTRY_VALUES = new Set([
  "UNITED STATES",
  "UNITED STATES OF AMERICA",
  "US",
  "USA",
]);
const PUERTO_RICO_REGION_VALUES = new Set(["PR", "PUERTO RICO"]);

function required(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AirbnbHostSelfServiceError(code);
  }
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalInteger(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
    );
  }
  return value;
}

function optionalFiniteNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
    );
  }
  return value;
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

function normalizedLocationToken(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

function normalizePinGoCountryForAirbnb(
  country: string | null,
  region: string | null
): string | null {
  const normalizedCountry = normalizedLocationToken(country);
  const normalizedRegion = normalizedLocationToken(region);
  if (
    UNITED_STATES_COUNTRY_VALUES.has(normalizedCountry) &&
    PUERTO_RICO_REGION_VALUES.has(normalizedRegion)
  ) {
    return "Puerto Rico";
  }
  return country;
}

function detailsFailureReasons(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  const value = error as { code?: unknown; providerStatus?: unknown };
  const code = typeof value.code === "string" ? value.code : null;
  const providerStatus =
    typeof value.providerStatus === "number" &&
    Number.isInteger(value.providerStatus) &&
    value.providerStatus >= 400 &&
    value.providerStatus <= 599
      ? value.providerStatus
      : null;

  const reasons: string[] = [];
  const byCode: Readonly<Record<string, string>> = {
    OTA_AIRBNB_LISTING_DISCOVERY_NOT_FOUND: "DETAILS_NOT_FOUND",
    OTA_AIRBNB_LISTING_DISCOVERY_RATE_LIMITED: "DETAILS_RATE_LIMITED",
    OTA_AIRBNB_LISTING_DISCOVERY_REQUEST_REJECTED: "DETAILS_REQUEST_REJECTED",
    OTA_AIRBNB_LISTING_DISCOVERY_PROVIDER_UNAVAILABLE: "DETAILS_PROVIDER_UNAVAILABLE",
    OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_TOO_LARGE: "DETAILS_RESPONSE_TOO_LARGE",
    OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID: "DETAILS_RESPONSE_INVALID",
    OTA_AIRBNB_LISTING_DISCOVERY_TRANSPORT_UNAVAILABLE: "DETAILS_TRANSPORT_UNAVAILABLE",
  };
  if (code && byCode[code]) reasons.push(byCode[code]);
  if (providerStatus != null) reasons.push(`DETAILS_HTTP_${providerStatus}`);
  return reasons;
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

export function parseAirbnbListingDetailsPayload(
  payload: unknown
): AirbnbListingDetailsEvidence {
  const root = record(payload);
  const data = record(root?.data);
  const listing = record(data?.listing);
  if (!listing) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
    );
  }

  return {
    listingId: required(
      listing.id_str,
      "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
    ),
    personCapacity: optionalInteger(listing.person_capacity),
    city: optionalText(listing.city),
    state: optionalText(listing.state),
    postalCode: optionalText(listing.zipcode),
    countryCode: optionalText(listing.country_code),
    latitude: optionalFiniteNumber(listing.lat),
    longitude: optionalFiniteNumber(listing.lng),
  };
}

function appendReason(
  decision: AirbnbPropertyMatchDecision,
  reason: string
): AirbnbPropertyMatchDecision {
  return decision.reasons.includes(reason)
    ? decision
    : { ...decision, reasons: [...decision.reasons, reason] };
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

  const propertyRows = await args.client.property.findMany({
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
      region: true,
      country: true,
      postalCode: true,
      maxGuests: true,
    },
  });
  const properties: PinGoPropertyMatchInput[] = propertyRows.map(
    ({ region, ...property }) => ({
      ...property,
      country: normalizePinGoCountryForAirbnb(property.country, region),
    })
  );

  const property = properties.find((candidate) => candidate.id === propertyId);
  if (!property) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_PROPERTY_NOT_FOUND"
    );
  }

  const payload = await args.transport.listAirbnbListings(channelId);
  const listings = parseAirbnbListingDiscoveryPayload(payload);
  const portfolio = matchAirbnbPropertyPortfolio({ properties, listings });
  let match = portfolio.decisions.find(
    (decision) => decision.propertyId === propertyId
  );

  if (!match) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_PROPERTY_MATCHING_FAILED"
    );
  }

  const shouldCorroborate =
    match.status === "REVIEW_REQUIRED" &&
    Boolean(match.candidateListingId) &&
    Boolean(property.postalCode?.trim()) &&
    match.reasons.includes("CITY_MISMATCH") &&
    !match.reasons.includes("AMBIGUOUS_RUNNER_UP") &&
    !match.reasons.includes("LISTING_CONFLICT");

  if (shouldCorroborate && match.candidateListingId) {
    const candidate = listings.find(
      (listing) => listing.id === match!.candidateListingId
    );
    if (candidate) {
      try {
        const detailsPayload = await args.transport.getAirbnbListingDetails(
          channelId,
          match.candidateListingId
        );
        const details = parseAirbnbListingDetailsPayload(detailsPayload);
        match = corroborateAirbnbPropertyMatch({
          property,
          listing: candidate,
          decision: match,
          details,
        });
      } catch (error) {
        match = appendReason(match, "DETAILS_UNAVAILABLE");
        for (const reason of detailsFailureReasons(error)) {
          match = appendReason(match, reason);
        }
      }
    }
  }

  return {
    channelId,
    listings,
    match,
  };
}
