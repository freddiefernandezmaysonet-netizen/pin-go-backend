import type { ChannexReadonlyTransport } from "./channex-readonly.http-transport.js";
import type {
  AirbnbListingDiscoveryResult,
} from "./airbnb-host-self-service.listings.service.js";
import type {
  AirbnbHostConfirmedMappingTransport,
} from "./airbnb-host-confirmed-mapping.http-transport.js";

export const AIRBNB_HOST_MAPPING_CONFIRMATION =
  "CONFIRM_AIRBNB_PROPERTY_MAPPING";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AIRBNB_LISTING_ID = /^\d{1,32}$/;
const MAPPING_ELIGIBLE_STATUSES = new Set([
  "NOT_CONNECTED",
  "AUTHORIZATION_REQUIRED",
  "MAPPING_REQUIRED",
]);

type JsonRecord = Record<string, unknown>;

type DistributionPropertyRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  platform: string;
  provisioningStatus: string;
  externalPropertyId: string | null;
  externalPrimaryRatePlanId: string | null;
  group: {
    organizationId: string;
    platform: string;
    provisioningStatus: string;
    externalGroupId: string | null;
  } | null;
};

type OtaConnectionRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  distributionPropertyId: string;
  provider: string;
  status: string;
  externalConnectionId: string | null;
};

export type AirbnbHostConfirmedMappingClient = {
  distributionProperty: {
    findFirst(args: unknown): Promise<DistributionPropertyRecord | null>;
  };
  otaChannelConnection: {
    findFirst(args: unknown): Promise<OtaConnectionRecord | null>;
  };
};

export type AirbnbHostConfirmedMappingResult = {
  outcome: "MAPPING_SUBMITTED" | "ALREADY_MAPPED";
  listingId: string;
  mappingId: string | null;
};

export class AirbnbHostConfirmedMappingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AirbnbHostConfirmedMappingError";
  }
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function requiredText(value: unknown, code: string, max = 255): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > max) {
    throw new AirbnbHostConfirmedMappingError(code);
  }
  return normalized;
}

function requiredUuid(value: unknown, code: string): string {
  const normalized = requiredText(value, code, 120);
  if (!UUID.test(normalized)) throw new AirbnbHostConfirmedMappingError(code);
  return normalized;
}

function requiredListingId(value: unknown): string {
  const normalized = requiredText(
    value,
    "OTA_AIRBNB_MAPPING_LISTING_ID_INVALID",
    32
  );
  if (!AIRBNB_LISTING_ID.test(normalized)) {
    throw new AirbnbHostConfirmedMappingError(
      "OTA_AIRBNB_MAPPING_LISTING_ID_INVALID"
    );
  }
  return normalized;
}

function loadMappingContext(args: {
  distributionProperty: DistributionPropertyRecord | null;
  connection: OtaConnectionRecord | null;
  organizationId: string;
  propertyId: string;
}) {
  const { distributionProperty, connection, organizationId, propertyId } = args;
  if (!distributionProperty || !connection) {
    throw new AirbnbHostConfirmedMappingError(
      "OTA_AIRBNB_MAPPING_CONTEXT_NOT_FOUND"
    );
  }
  if (
    distributionProperty.organizationId !== organizationId ||
    distributionProperty.propertyId !== propertyId ||
    distributionProperty.platform !== "CHANNEX" ||
    distributionProperty.provisioningStatus !== "READY" ||
    !distributionProperty.group ||
    distributionProperty.group.organizationId !== organizationId ||
    distributionProperty.group.platform !== "CHANNEX" ||
    distributionProperty.group.provisioningStatus !== "READY" ||
    connection.organizationId !== organizationId ||
    connection.propertyId !== propertyId ||
    connection.distributionPropertyId !== distributionProperty.id ||
    connection.provider !== "AIRBNB" ||
    !MAPPING_ELIGIBLE_STATUSES.has(connection.status)
  ) {
    throw new AirbnbHostConfirmedMappingError(
      "OTA_AIRBNB_MAPPING_CONTEXT_NOT_ELIGIBLE"
    );
  }

  return {
    channelId: requiredUuid(
      connection.externalConnectionId,
      "OTA_AIRBNB_MAPPING_CHANNEL_ID_INVALID"
    ),
    externalPropertyId: requiredUuid(
      distributionProperty.externalPropertyId,
      "OTA_AIRBNB_MAPPING_PROPERTY_ID_INVALID"
    ),
    ratePlanId: requiredUuid(
      distributionProperty.externalPrimaryRatePlanId,
      "OTA_AIRBNB_MAPPING_RATE_PLAN_ID_INVALID"
    ),
    groupId: requiredUuid(
      distributionProperty.group.externalGroupId,
      "OTA_AIRBNB_MAPPING_GROUP_ID_INVALID"
    ),
  };
}

type ExistingMapping = {
  id: string;
  ratePlanId: string;
  listingId: string;
};

function parseExactChannel(args: {
  payload: unknown;
  channelId: string;
  externalPropertyId: string;
  groupId: string;
}): { mappings: ExistingMapping[] } {
  const root = record(args.payload);
  const channel = root ? record(root.data) : null;
  const attributes = channel ? record(channel.attributes) : null;
  const relationships = channel ? record(channel.relationships) : null;
  const groupRelationship = relationships ? record(relationships.group) : null;
  const group = groupRelationship ? record(groupRelationship.data) : null;
  const channelId = channel ? String(channel.id ?? "").trim() : "";
  const groupId = group ? String(group.id ?? "").trim() : "";
  const properties = attributes?.properties;
  const ratePlans = attributes?.rate_plans;

  if (
    !root ||
    !channel ||
    channel.type !== "channel" ||
    !attributes ||
    channelId !== args.channelId ||
    attributes.channel !== "Airbnb" ||
    attributes.is_active !== false ||
    !Array.isArray(properties) ||
    !properties.every((value) => typeof value === "string" && UUID.test(value)) ||
    !properties.includes(args.externalPropertyId) ||
    !group ||
    group.type !== "group" ||
    groupId !== args.groupId ||
    !Array.isArray(ratePlans)
  ) {
    throw new AirbnbHostConfirmedMappingError(
      "OTA_AIRBNB_MAPPING_CHANNEL_STATE_INVALID"
    );
  }

  const mappings = ratePlans.map((value): ExistingMapping => {
    const mapping = record(value);
    const settings = mapping ? record(mapping.settings) : null;
    const id = mapping ? String(mapping.id ?? "").trim() : "";
    const ratePlanId = mapping
      ? String(mapping.rate_plan_id ?? "").trim()
      : "";
    const listingId = settings
      ? String(settings.listing_id ?? "").trim()
      : "";
    if (
      !mapping ||
      !UUID.test(id) ||
      !UUID.test(ratePlanId) ||
      !AIRBNB_LISTING_ID.test(listingId)
    ) {
      throw new AirbnbHostConfirmedMappingError(
        "OTA_AIRBNB_MAPPING_CHANNEL_STATE_INVALID"
      );
    }
    return { id, ratePlanId, listingId };
  });

  return { mappings };
}

function ensureCandidateWasConfirmed(args: {
  discovery: AirbnbListingDiscoveryResult;
  channelId: string;
  propertyId: string;
  listingId: string;
}) {
  if (
    args.discovery.channelId !== args.channelId ||
    args.discovery.match.propertyId !== args.propertyId ||
    args.discovery.match.status === "UNMATCHED" ||
    args.discovery.match.candidateListingId !== args.listingId ||
    !args.discovery.listings.some((listing) => listing.id === args.listingId) ||
    args.discovery.match.reasons.includes("LISTING_CONFLICT")
  ) {
    throw new AirbnbHostConfirmedMappingError(
      "OTA_AIRBNB_MAPPING_CONFIRMATION_MISMATCH"
    );
  }
}

function parseMappingResponse(args: {
  payload: unknown;
  channelId: string;
  listingId: string;
}): string {
  const root = record(args.payload);
  const data = root ? record(root.data) : null;
  const attributes = data ? record(data.attributes) : null;
  const settings = attributes ? record(attributes.settings) : null;
  const relationships = data ? record(data.relationships) : null;
  const channelRelationship = relationships ? record(relationships.channel) : null;
  const channel = channelRelationship ? record(channelRelationship.data) : null;
  const mappingId = attributes ? String(attributes.id ?? "").trim() : "";
  const listingId = settings ? String(settings.listing_id ?? "").trim() : "";
  const responseChannelId = data ? String(data.id ?? "").trim() : "";
  const relationshipChannelId = channel ? String(channel.id ?? "").trim() : "";

  if (
    !root ||
    !data ||
    data.type !== "channel_rate_plan" ||
    responseChannelId !== args.channelId ||
    !attributes ||
    !UUID.test(mappingId) ||
    !settings ||
    listingId !== args.listingId ||
    !channel ||
    channel.type !== "channel" ||
    relationshipChannelId !== args.channelId
  ) {
    throw new AirbnbHostConfirmedMappingError(
      "OTA_AIRBNB_MAPPING_RESPONSE_INVALID"
    );
  }
  return mappingId;
}

export async function confirmAirbnbHostMapping(args: {
  client: AirbnbHostConfirmedMappingClient;
  readonlyTransport: Pick<ChannexReadonlyTransport, "getChannel">;
  mappingTransport: AirbnbHostConfirmedMappingTransport;
  discoverListings(input: {
    organizationId: string;
    propertyId: string;
  }): Promise<AirbnbListingDiscoveryResult>;
  organizationId: string;
  propertyId: string;
  listingId: string;
  confirmation: string;
}): Promise<AirbnbHostConfirmedMappingResult> {
  const organizationId = requiredText(
    args.organizationId,
    "OTA_AIRBNB_MAPPING_TENANT_INVALID",
    120
  );
  const propertyId = requiredText(
    args.propertyId,
    "OTA_AIRBNB_MAPPING_PROPERTY_INVALID",
    120
  );
  const listingId = requiredListingId(args.listingId);
  if (args.confirmation !== AIRBNB_HOST_MAPPING_CONFIRMATION) {
    throw new AirbnbHostConfirmedMappingError(
      "OTA_AIRBNB_MAPPING_EXPLICIT_CONFIRMATION_REQUIRED"
    );
  }

  const [distributionProperty, connection] = await Promise.all([
    args.client.distributionProperty.findFirst({
      where: { organizationId, propertyId, platform: "CHANNEX" },
      select: {
        id: true,
        organizationId: true,
        propertyId: true,
        platform: true,
        provisioningStatus: true,
        externalPropertyId: true,
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
    }),
    args.client.otaChannelConnection.findFirst({
      where: { organizationId, propertyId, provider: "AIRBNB" },
      select: {
        id: true,
        organizationId: true,
        propertyId: true,
        distributionPropertyId: true,
        provider: true,
        status: true,
        externalConnectionId: true,
      },
    }),
  ]);

  const context = loadMappingContext({
    distributionProperty,
    connection,
    organizationId,
    propertyId,
  });

  const discovery = await args.discoverListings({ organizationId, propertyId });
  ensureCandidateWasConfirmed({
    discovery,
    channelId: context.channelId,
    propertyId,
    listingId,
  });

  const channelPayload = await args.readonlyTransport.getChannel(context.channelId);
  const channel = parseExactChannel({
    payload: channelPayload,
    channelId: context.channelId,
    externalPropertyId: context.externalPropertyId,
    groupId: context.groupId,
  });

  const exact = channel.mappings.find(
    (mapping) =>
      mapping.ratePlanId === context.ratePlanId &&
      mapping.listingId === listingId
  );
  if (exact) {
    return {
      outcome: "ALREADY_MAPPED",
      listingId,
      mappingId: exact.id,
    };
  }

  const conflict = channel.mappings.some(
    (mapping) =>
      (mapping.ratePlanId === context.ratePlanId &&
        mapping.listingId !== listingId) ||
      (mapping.listingId === listingId &&
        mapping.ratePlanId !== context.ratePlanId)
  );
  if (conflict) {
    throw new AirbnbHostConfirmedMappingError(
      "OTA_AIRBNB_MAPPING_CONFLICT"
    );
  }

  const mappingPayload = await args.mappingTransport.createMapping({
    channelId: context.channelId,
    ratePlanId: context.ratePlanId,
    listingId,
  });
  const mappingId = parseMappingResponse({
    payload: mappingPayload,
    channelId: context.channelId,
    listingId,
  });

  return {
    outcome: "MAPPING_SUBMITTED",
    listingId,
    mappingId,
  };
}
