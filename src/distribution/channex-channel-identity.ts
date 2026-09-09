import type { ConnectionCenterProvider } from "./connection-center.read-model.js";

export type ChannexChannelDiscoveryResult =
  | { outcome: "FOUND"; channelId: string; candidateCount: 1 }
  | {
      outcome: "NOT_FOUND" | "AMBIGUOUS";
      channelId: null;
      candidateCount: number;
    };

export type ChannexChannelVerificationReason =
  | "CHANNEL_IDENTITY_NOT_VERIFIED"
  | "CHANNEL_RESOURCE_TYPE_NOT_VERIFIED"
  | "CHANNEL_PROVIDER_NOT_VERIFIED"
  | "CHANNEL_PROPERTY_NOT_VERIFIED"
  | "CHANNEL_GROUP_NOT_VERIFIED"
  | "CHANNEL_ACTIVE_STATE_NOT_VERIFIED"
  | "NO_CONNECTED_CHANNEL_EVIDENCE"
  | "CHANNEL_OUTBOUND_MAPPING_NOT_VERIFIED"
  | "CHANNEL_AIRBNB_LISTING_NOT_VERIFIED"
  | "CHANNEL_MAPPING_NOT_VERIFIED";

export type ChannexChannelVerification = {
  channelId: string | null;
  resourceTypeVerified: boolean;
  providerVerified: boolean;
  propertyVerified: boolean;
  groupVerified: boolean;
  identityVerified: boolean;
  activeState: boolean | null;
  connectedEvidenceVerified: boolean;
  knownMappingVerified: boolean;
  outboundMappingVerified: boolean;
  airbnbListingVerified: boolean;
  airbnbListingId: string | null;
  mappingVerified: boolean;
  reasons: ChannexChannelVerificationReason[];
};

export class ChannexChannelIdentityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ChannexChannelIdentityError";
  }
}

type JsonRecord = Record<string, unknown>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DOCUMENTED_CHANNEL_BY_PROVIDER: Readonly<
  Record<ConnectionCenterProvider, string>
> = {
  AIRBNB: "Airbnb",
  BOOKING_COM: "BookingCom",
  EXPEDIA: "Expedia",
  VRBO: "Vrbo",
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function uuid(value: unknown): string | null {
  const result = typeof value === "string" ? value.trim() : "";
  return UUID.test(result) ? result : null;
}

function requiredExpectedUuid(value: string, code: string): string {
  const result = uuid(value);
  if (!result) throw new ChannexChannelIdentityError(code);
  return result;
}

function requiredNonEmptyCode(value: unknown): string | null {
  const result = typeof value === "string" ? value.trim() : "";
  return result && result.length <= 255 ? result : null;
}

function safeExternalListingId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value !== value.trim()) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(value) ? value : null;
}

function invalidCollection(): never {
  throw new ChannexChannelIdentityError(
    "OTA_CHANNEL_COLLECTION_RESPONSE_INVALID"
  );
}

function invalidResource(): never {
  throw new ChannexChannelIdentityError(
    "OTA_CHANNEL_RESOURCE_RESPONSE_INVALID"
  );
}

function documentedPropertyIds(
  channel: JsonRecord,
  invalid: () => never
): string[] {
  const relationships = record(channel.relationships);
  const relationship = relationships
    ? record(relationships.properties)
    : null;
  if (!relationship || !Array.isArray(relationship.data)) invalid();

  return relationship.data.map((value) => {
    const property = record(value);
    const propertyId = property ? uuid(property.id) : null;
    if (!property || property.type !== "property" || !propertyId) invalid();
    return propertyId;
  });
}

function documentedAttributePropertyIds(
  channel: JsonRecord,
  invalid: () => never
): string[] {
  const attributes = record(channel.attributes);
  if (!attributes || !Array.isArray(attributes.properties)) invalid();
  const propertyIds = attributes.properties.map((value) => {
    const propertyId = uuid(value);
    if (!propertyId) invalid();
    return propertyId;
  });
  if (new Set(propertyIds).size !== propertyIds.length) invalid();
  return propertyIds;
}

function sameIdSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function validateDocumentedPropertySources(
  channel: JsonRecord,
  invalid: () => never
): string[] {
  const relationshipIds = documentedPropertyIds(channel, invalid);
  const attributeIds = documentedAttributePropertyIds(channel, invalid);
  if (!sameIdSet(relationshipIds, attributeIds)) invalid();
  return relationshipIds;
}

function validateDocumentedGroup(
  channel: JsonRecord,
  invalid: () => never
): string {
  const relationships = record(channel.relationships);
  const groupRelationship = relationships
    ? record(relationships.group)
    : null;
  const group = groupRelationship ? record(groupRelationship.data) : null;
  const groupId = group ? uuid(group.id) : null;
  if (!group || group.type !== "group" || !groupId) invalid();
  return groupId;
}

function channelResourceList(payload: unknown): JsonRecord[] {
  const root = record(payload);
  if (!root || !Array.isArray(root.data) || !record(root.meta)) {
    return invalidCollection();
  }
  return root.data.map((value) => {
    const resource = record(value);
    const resourceId = resource ? uuid(resource.id) : null;
    if (!resource || resource.type !== "channel" || !resourceId) {
      return invalidCollection();
    }
    if (!record(resource.attributes)) return invalidCollection();
    validateDocumentedPropertySources(resource, invalidCollection);
    return resource;
  });
}

/**
 * Discovery identifies a candidate only when the documented list resource
 * proves one unique provider/property pair. The id is not readiness evidence
 * until an exact getChannel response is verified.
 */
export function discoverUniqueChannexChannel(args: {
  payload: unknown;
  provider: ConnectionCenterProvider;
  expectedPropertyId: string;
}): ChannexChannelDiscoveryResult {
  const expectedPropertyId = requiredExpectedUuid(
    args.expectedPropertyId,
    "OTA_CHANNEL_EXPECTED_PROPERTY_ID_INVALID"
  );
  const expectedChannel = DOCUMENTED_CHANNEL_BY_PROVIDER[args.provider];
  const candidateIds = new Set<string>();

  for (const resource of channelResourceList(args.payload)) {
    const attributes = record(resource.attributes)!;
    if (attributes.channel !== expectedChannel) continue;
    if (
      !validateDocumentedPropertySources(resource, invalidCollection).includes(
        expectedPropertyId
      )
    ) {
      continue;
    }
    candidateIds.add(uuid(resource.id)!);
  }

  if (candidateIds.size === 0) {
    return { outcome: "NOT_FOUND", channelId: null, candidateCount: 0 };
  }
  if (candidateIds.size > 1) {
    return {
      outcome: "AMBIGUOUS",
      channelId: null,
      candidateCount: candidateIds.size,
    };
  }
  return {
    outcome: "FOUND",
    channelId: [...candidateIds][0]!,
    candidateCount: 1,
  };
}

type DocumentedKnownMapping = {
  id: string;
  roomTypeId: string;
  ratePlanId: string;
  roomTypeCode: string;
  ratePlanCode: string;
};

function documentedKnownMappings(channel: JsonRecord): DocumentedKnownMapping[] {
  const relationships = record(channel.relationships);
  const relationship = relationships
    ? record(relationships.known_mappings)
    : null;
  if (!relationship || !Array.isArray(relationship.data)) {
    return invalidResource();
  }

  return relationship.data.map((value) => {
    const mapping = record(value);
    const attributes = mapping ? record(mapping.attributes) : null;
    const mappingId = mapping ? uuid(mapping.id) : null;
    const attributeId = attributes ? uuid(attributes.id) : null;
    const roomTypeId = attributes ? uuid(attributes.room_type_id) : null;
    const ratePlanId = attributes ? uuid(attributes.rate_plan_id) : null;
    const roomTypeCode = attributes
      ? requiredNonEmptyCode(attributes.room_type_code)
      : null;
    const ratePlanCode = attributes
      ? requiredNonEmptyCode(attributes.rate_plan_code)
      : null;
    if (
      !mapping ||
      mapping.type !== "known_mapping" ||
      !attributes ||
      !mappingId ||
      !attributeId ||
      mappingId !== attributeId ||
      (attributes.type !== "auto" && attributes.type !== "manual") ||
      !roomTypeId ||
      !ratePlanId ||
      !roomTypeCode ||
      !ratePlanCode
    ) {
      return invalidResource();
    }
    return {
      id: mappingId,
      roomTypeId,
      ratePlanId,
      roomTypeCode,
      ratePlanCode,
    };
  });
}

type DocumentedOutboundMapping = {
  id: string;
  ratePlanId: string;
  listingId: string | null;
};

function documentedOutboundMappings(
  attributes: JsonRecord
): DocumentedOutboundMapping[] {
  if (!Array.isArray(attributes.rate_plans)) return invalidResource();
  return attributes.rate_plans.map((value) => {
    const mapping = record(value);
    const id = mapping ? uuid(mapping.id) : null;
    const ratePlanId = mapping ? uuid(mapping.rate_plan_id) : null;
    const settings = mapping ? record(mapping.settings) : null;
    if (!mapping || !id || !ratePlanId || !settings) return invalidResource();
    return {
      id,
      ratePlanId,
      listingId: safeExternalListingId(settings.listing_id),
    };
  });
}

export function verifyExactChannexChannel(args: {
  payload: unknown;
  provider: ConnectionCenterProvider;
  expectedChannelId: string;
  expectedPropertyId: string;
  expectedGroupId: string;
  expectedRoomTypeId: string;
  expectedRatePlanId: string;
  expectedAirbnbListingId?: string;
}): ChannexChannelVerification {
  const expectedChannelId = requiredExpectedUuid(
    args.expectedChannelId,
    "OTA_CHANNEL_EXPECTED_CHANNEL_ID_INVALID"
  );
  const expectedPropertyId = requiredExpectedUuid(
    args.expectedPropertyId,
    "OTA_CHANNEL_EXPECTED_PROPERTY_ID_INVALID"
  );
  const expectedGroupId = requiredExpectedUuid(
    args.expectedGroupId,
    "OTA_CHANNEL_EXPECTED_GROUP_ID_INVALID"
  );
  const expectedRoomTypeId = requiredExpectedUuid(
    args.expectedRoomTypeId,
    "OTA_CHANNEL_EXPECTED_ROOM_TYPE_ID_INVALID"
  );
  const expectedRatePlanId = requiredExpectedUuid(
    args.expectedRatePlanId,
    "OTA_CHANNEL_EXPECTED_RATE_PLAN_ID_INVALID"
  );
  const expectedAirbnbListingId =
    args.provider !== "AIRBNB" || args.expectedAirbnbListingId === undefined
      ? null
      : safeExternalListingId(args.expectedAirbnbListingId);
  if (
    args.provider === "AIRBNB" &&
    args.expectedAirbnbListingId !== undefined &&
    expectedAirbnbListingId === null
  ) {
    throw new ChannexChannelIdentityError(
      "OTA_CHANNEL_EXPECTED_AIRBNB_LISTING_ID_INVALID"
    );
  }

  const root = record(args.payload);
  const channel = root ? record(root.data) : null;
  const attributes = channel ? record(channel.attributes) : null;
  if (!root || !channel || !attributes) return invalidResource();

  const channelId = uuid(channel.id);
  const attributeId = uuid(attributes.id);
  if (!channelId || !attributeId || channelId !== attributeId) {
    return invalidResource();
  }
  const properties = validateDocumentedPropertySources(channel, invalidResource);
  const groupId = validateDocumentedGroup(channel, invalidResource);
  const knownMappings = documentedKnownMappings(channel);
  const outboundMappings = documentedOutboundMappings(attributes);

  const resourceTypeVerified = channel.type === "channel";
  const providerVerified =
    attributes.channel === DOCUMENTED_CHANNEL_BY_PROVIDER[args.provider];
  const propertyVerified = properties.includes(expectedPropertyId);
  const groupVerified = groupId === expectedGroupId;
  const identityVerified =
    channelId === expectedChannelId &&
    resourceTypeVerified &&
    providerVerified &&
    propertyVerified &&
    groupVerified;
  const activeState =
    typeof attributes.is_active === "boolean" ? attributes.is_active : null;
  // Channex no longer guarantees `status` for non-Google channels. When it is
  // absent, `is_active` is the documented channel gate. When an exact resource
  // does include it, never promote a known non-active or malformed state.
  const operationalStatusCompatible =
    !Object.prototype.hasOwnProperty.call(attributes, "status") ||
    attributes.status === "active";
  const connectedEvidenceVerified =
    identityVerified && activeState === true && operationalStatusCompatible;
  const knownMappingVerified = knownMappings.some(
    (mapping) =>
      mapping.roomTypeId === expectedRoomTypeId &&
      mapping.ratePlanId === expectedRatePlanId
  );
  const expectedOutboundMappings = outboundMappings.filter(
    (mapping) => mapping.ratePlanId === expectedRatePlanId
  );
  const airbnbListingId =
    args.provider === "AIRBNB" &&
    expectedOutboundMappings.length === 1 &&
    expectedOutboundMappings[0]!.listingId !== null
      ? expectedOutboundMappings[0]!.listingId
      : null;
  const airbnbListingVerified =
    args.provider !== "AIRBNB" ||
    (airbnbListingId !== null &&
      (expectedAirbnbListingId === null ||
        airbnbListingId === expectedAirbnbListingId));
  const outboundMappingVerified = outboundMappings.some(
    (mapping) =>
      mapping.ratePlanId === expectedRatePlanId &&
      args.provider !== "AIRBNB"
  ) || (args.provider === "AIRBNB" && airbnbListingVerified);
  const mappingVerified = identityVerified && outboundMappingVerified;

  const reasons: ChannexChannelVerificationReason[] = [];
  if (!identityVerified) reasons.push("CHANNEL_IDENTITY_NOT_VERIFIED");
  if (!resourceTypeVerified) {
    reasons.push("CHANNEL_RESOURCE_TYPE_NOT_VERIFIED");
  }
  if (!providerVerified) reasons.push("CHANNEL_PROVIDER_NOT_VERIFIED");
  if (!propertyVerified) reasons.push("CHANNEL_PROPERTY_NOT_VERIFIED");
  if (!groupVerified) reasons.push("CHANNEL_GROUP_NOT_VERIFIED");
  if (activeState === null) {
    reasons.push("CHANNEL_ACTIVE_STATE_NOT_VERIFIED");
  } else if (!connectedEvidenceVerified) {
    reasons.push("NO_CONNECTED_CHANNEL_EVIDENCE");
  }
  if (!outboundMappingVerified) {
    reasons.push("CHANNEL_OUTBOUND_MAPPING_NOT_VERIFIED");
  }
  if (!airbnbListingVerified) {
    reasons.push("CHANNEL_AIRBNB_LISTING_NOT_VERIFIED");
  }
  if (!mappingVerified) reasons.push("CHANNEL_MAPPING_NOT_VERIFIED");

  return {
    channelId,
    resourceTypeVerified,
    providerVerified,
    propertyVerified,
    groupVerified,
    identityVerified,
    activeState,
    connectedEvidenceVerified,
    knownMappingVerified,
    outboundMappingVerified,
    airbnbListingVerified,
    airbnbListingId,
    mappingVerified,
    reasons,
  };
}
