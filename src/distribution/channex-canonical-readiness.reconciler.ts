import type { ConnectionCenterProvider } from "./connection-center.read-model.js";
import type { ChannexChannelVerification } from "./channex-channel-identity.js";

export type CanonicalReadiness =
  | "REQUIRED"
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "READY"
  | "BLOCKED";

export type CanonicalLifecycleEvent =
  | "new_channel"
  | "updated_channel"
  | "activate_channel"
  | "deactivate_channel"
  | "disconnect_channel"
  | "disconnect_listing";

export type CanonicalOtaReadinessEvidence = {
  provider: ConnectionCenterProvider;
  expectedPropertyId: string;
  expectedRoomTypeId: string;
  expectedRatePlanId: string;
  propertyPayload: unknown;
  roomTypePayload: unknown;
  ratePlanPayload: unknown;
  channelVerification: ChannexChannelVerification | null;
  channelResolutionReason?:
    | "CHANNEL_DISCOVERY_NOT_FOUND"
    | "CHANNEL_DISCOVERY_AMBIGUOUS"
    | "CHANNEL_DISCOVERY_STORED_ID_MISMATCH"
    | "CHANNEL_EXACT_NOT_FOUND"
    | "CHANNEL_COLLECTION_CONTRACT_INVALID"
    | "CHANNEL_RESOURCE_CONTRACT_INVALID"
    | null;
  latestLifecycleEvent?: CanonicalLifecycleEvent | null;
  channelAuthorizationVerifiedAt?: Date | null;
  lastChannelActivatedAt?: Date | null;
};

export type CanonicalOtaReadinessResult = {
  authorizationReadiness: CanonicalReadiness;
  mappingReadiness: CanonicalReadiness;
  distributionReadiness: CanonicalReadiness;
  reasons: string[];
};

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function dataRecord(payload: unknown): Record<string, any> {
  return record(record(payload).data);
}

function resourceId(item: Record<string, any>): string {
  return typeof item.id === "string" ? item.id.trim() : "";
}

function exactResource(
  payload: unknown,
  type: string,
  expectedId: string
): Record<string, any> | null {
  const resource = dataRecord(payload);
  const attributes = record(resource.attributes);
  return resource.type === type &&
    resourceId(resource) === expectedId &&
    typeof attributes.id === "string" &&
    attributes.id.trim() === expectedId
    ? resource
    : null;
}

function relationshipMatches(
  resource: Record<string, any>,
  relationshipName: string,
  type: string,
  expectedId: string
): boolean {
  const relationship = record(record(resource.relationships)[relationshipName]);
  const identifier = record(relationship.data);
  return (
    identifier.type === type && resourceId(identifier) === expectedId
  );
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

function validInstant(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function deriveCanonicalOtaReadiness(
  evidence: CanonicalOtaReadinessEvidence
): CanonicalOtaReadinessResult {
  const reasons: string[] = [];
  const property = exactResource(
    evidence.propertyPayload,
    "property",
    evidence.expectedPropertyId
  );
  const roomType = exactResource(
    evidence.roomTypePayload,
    "room_type",
    evidence.expectedRoomTypeId
  );
  const ratePlan = exactResource(
    evidence.ratePlanPayload,
    "rate_plan",
    evidence.expectedRatePlanId
  );
  const propertyMatches = Boolean(property);
  const roomMatches = Boolean(
    roomType &&
      relationshipMatches(
        roomType,
        "property",
        "property",
        evidence.expectedPropertyId
      )
  );
  const rateMatches = Boolean(
    ratePlan &&
      relationshipMatches(
        ratePlan,
        "property",
        "property",
        evidence.expectedPropertyId
      ) &&
      relationshipMatches(
        ratePlan,
        "room_type",
        "room_type",
        evidence.expectedRoomTypeId
      )
  );
  const channel = evidence.channelVerification;
  const channelIdentity = channel?.identityVerified === true;
  const channelActive = channel?.activeState ?? null;
  const channelConnected = channel?.connectedEvidenceVerified === true;
  const channelMapping = channel?.mappingVerified === true;
  const lifecycle = evidence.latestLifecycleEvent ?? null;
  const authorizationObserved = validInstant(
    evidence.channelAuthorizationVerifiedAt
  );
  const activationObserved = validInstant(evidence.lastChannelActivatedAt);

  if (!propertyMatches) pushUnique(reasons, "PROPERTY_NOT_CANONICALLY_VERIFIED");
  if (!roomMatches) pushUnique(reasons, "ROOM_TYPE_NOT_CANONICALLY_VERIFIED");
  if (!rateMatches) pushUnique(reasons, "RATE_PLAN_NOT_CANONICALLY_VERIFIED");
  if (evidence.channelResolutionReason) {
    pushUnique(reasons, evidence.channelResolutionReason);
  }
  for (const reason of channel?.reasons ?? []) pushUnique(reasons, reason);
  if (!channelIdentity) pushUnique(reasons, "CHANNEL_IDENTITY_NOT_VERIFIED");
  if (!channelMapping) pushUnique(reasons, "CHANNEL_MAPPING_NOT_VERIFIED");
  if (channelActive === null) {
    pushUnique(reasons, "CHANNEL_ACTIVE_STATE_NOT_VERIFIED");
  } else if (!channelActive) {
    pushUnique(reasons, "CHANNEL_NOT_ACTIVE");
  }
  if (!activationObserved) {
    pushUnique(reasons, "CHANNEL_ACTIVATION_NOT_OBSERVED");
  }
  if (!authorizationObserved && !channelConnected) {
    pushUnique(reasons, "CHANNEL_AUTHORIZATION_NOT_VERIFIED");
  }

  if (lifecycle === "disconnect_channel") {
    pushUnique(reasons, "CHANNEL_DISCONNECTED");
    return {
      authorizationReadiness: "REQUIRED",
      mappingReadiness: "BLOCKED",
      distributionReadiness: "BLOCKED",
      reasons,
    };
  }

  // Channex does not expose an independent, read-only OAuth-success flag for
  // Airbnb. Current active state or a durable prior activate_channel watermark
  // is the minimum evidence that authorization completed; existence alone is
  // not enough. disconnect_channel is handled above and revokes this evidence.
  const authorizationReady =
    propertyMatches &&
    channelIdentity &&
    (channelConnected || authorizationObserved);
  const mappingReady =
    propertyMatches &&
    channelIdentity &&
    roomMatches &&
    rateMatches &&
    channelMapping;

  if (lifecycle === "disconnect_listing") {
    pushUnique(reasons, "LISTING_DISCONNECTED");
    return {
      authorizationReadiness: authorizationReady ? "READY" : "IN_PROGRESS",
      mappingReadiness: "BLOCKED",
      distributionReadiness: "BLOCKED",
      reasons,
    };
  }
  if (lifecycle === "deactivate_channel") {
    pushUnique(reasons, "CHANNEL_DEACTIVATED");
    return {
      authorizationReadiness: authorizationReady ? "READY" : "IN_PROGRESS",
      mappingReadiness: mappingReady ? "READY" : "IN_PROGRESS",
      distributionReadiness: "BLOCKED",
      reasons,
    };
  }

  const distributionReady =
    mappingReady && channelConnected && activationObserved;
  const distributionBlocked =
    propertyMatches && channelIdentity && channelActive === false;

  return {
    authorizationReadiness: authorizationReady ? "READY" : "IN_PROGRESS",
    mappingReadiness: mappingReady ? "READY" : "IN_PROGRESS",
    distributionReadiness: distributionReady
      ? "READY"
      : distributionBlocked
        ? "BLOCKED"
        : "IN_PROGRESS",
    reasons,
  };
}
