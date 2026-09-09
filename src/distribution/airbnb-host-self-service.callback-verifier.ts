export class AirbnbCallbackChannelVerificationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AirbnbCallbackChannelVerificationError";
  }
}

type JsonRecord = Record<string, unknown>;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function invalidResponse(): never {
  throw new AirbnbCallbackChannelVerificationError("OTA_AIRBNB_CHANNEL_RESPONSE_INVALID");
}

function identityMismatch(): never {
  throw new AirbnbCallbackChannelVerificationError("OTA_AIRBNB_CHANNEL_IDENTITY_NOT_VERIFIED");
}

/**
 * Reads only the exact channel resource and its tenant/property boundary.
 * The supplied guide's generic GET example has distinct data.id/attributes.id
 * and says BookingCom. Accepting that shape does NOT verify an Airbnb account.
 * Provider-specific evidence remains pending the separate listings gate.
 * No mapping parsing, payload rewriting, or shared-core relaxation occurs here.
 */
export function verifyAirbnbCallbackChannelResource(args: {
  payload: unknown;
  expectedChannelId: string;
  expectedPropertyId: string;
  expectedGroupId: string;
}): { channelId: string; activeState: boolean | null; airbnbAccountVerified: false } {
  const expectedChannelId = uuid(args.expectedChannelId);
  const expectedPropertyId = uuid(args.expectedPropertyId);
  const expectedGroupId = uuid(args.expectedGroupId);
  if (!expectedChannelId || !expectedPropertyId || !expectedGroupId) return invalidResponse();

  const root = record(args.payload);
  const channel = record(root?.data);
  const attributes = record(channel?.attributes);
  const relationships = record(channel?.relationships);
  const resourceId = uuid(channel?.id);
  if (!channel || channel.type !== "channel" || !attributes || !relationships || !resourceId) {
    return invalidResponse();
  }
  if (resourceId !== expectedChannelId) return identityMismatch();

  const properties = record(relationships.properties);
  const group = record(record(relationships.group)?.data);
  if (!Array.isArray(attributes.properties) || !Array.isArray(properties?.data) ||
      !group || group.type !== "group" || !uuid(group.id)) return invalidResponse();

  const attributeIds = attributes.properties.map((value) => uuid(value) ?? invalidResponse());
  const relationshipIds = properties.data.map((value) => {
    const property = record(value);
    if (!property || property.type !== "property") return invalidResponse();
    return uuid(property.id) ?? invalidResponse();
  });
  if (!attributeIds.includes(expectedPropertyId) ||
      !relationshipIds.includes(expectedPropertyId) || group.id !== expectedGroupId) {
    return identityMismatch();
  }

  return {
    channelId: resourceId,
    activeState: typeof attributes.is_active === "boolean" ? attributes.is_active : null,
    airbnbAccountVerified: false,
  };
}
