import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  AirbnbCallbackChannelVerificationError,
  verifyAirbnbCallbackChannelResource,
} from "./airbnb-host-self-service.callback-verifier.js";

export class AirbnbHostSelfServiceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AirbnbHostSelfServiceError";
  }
}

export type AirbnbHostSelfServiceClient = {
  distributionProperty: {
    findFirst(args: unknown): Promise<{
      organizationId: string;
      propertyId: string;
      platform: string;
      provisioningStatus: string;
      externalPropertyId: string | null;
      externalPrimaryRoomTypeId: string | null;
      externalPrimaryRatePlanId: string | null;
      group: {
        organizationId: string;
        platform: string;
        provisioningStatus: string;
        externalGroupId: string | null;
      } | null;
    } | null>;
  };
};

export type AirbnbHostSelfServiceTransport = {
  createConnectionLink(body: {
    connection_link: {
      group_id: string;
      properties: string[];
      redirect_uri: string;
      failure_redirect_uri: string;
      token: string;
    };
  }): Promise<unknown>;
  getChannel(channelId: string): Promise<unknown>;
};

export type AirbnbHostStateClaims = {
  version: 1;
  organizationId: string;
  propertyId: string;
  requestedByUserId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATE_TTL_MS = 2 * 60 * 60 * 1_000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function required(value: unknown, code: string, max = 255): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > max) {
    throw new AirbnbHostSelfServiceError(code);
  }
  return normalized;
}

function requiredUuid(value: unknown, code: string): string {
  const normalized = required(value, code, 120);
  if (!UUID.test(normalized)) throw new AirbnbHostSelfServiceError(code);
  return normalized;
}

function exactHttpsOrigin(value: string, code: string): string {
  try {
    const parsed = new URL(String(value ?? "").trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("invalid");
    }
    return parsed.origin;
  } catch {
    throw new AirbnbHostSelfServiceError(code);
  }
}

function stateSecret(value: string): Buffer {
  const normalized = String(value ?? "").trim();
  if (normalized.length < 32 || normalized.length > 4096) {
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_STATE_SECRET_INVALID");
  }
  return Buffer.from(normalized, "utf8");
}

function signPayload(encodedPayload: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function createAirbnbHostState(args: {
  secret: string;
  organizationId: string;
  propertyId: string;
  requestedByUserId: string;
  now?: Date;
  nonce?: string;
}): string {
  const nowMs = (args.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_STATE_CLOCK_INVALID");
  }
  const claims: AirbnbHostStateClaims = {
    version: 1,
    organizationId: required(args.organizationId, "OTA_AIRBNB_STATE_TENANT_INVALID", 120),
    propertyId: required(args.propertyId, "OTA_AIRBNB_STATE_PROPERTY_INVALID", 120),
    requestedByUserId: required(args.requestedByUserId, "OTA_AIRBNB_STATE_ACTOR_INVALID", 120),
    issuedAt: nowMs,
    expiresAt: nowMs + STATE_TTL_MS,
    nonce: required(
      args.nonce ?? randomBytes(18).toString("base64url"),
      "OTA_AIRBNB_STATE_NONCE_INVALID",
      120
    ),
  };
  const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${encoded}.${signPayload(encoded, stateSecret(args.secret))}`;
}

export function verifyAirbnbHostState(args: {
  token: string;
  secret: string;
  organizationId: string;
  requestedByUserId: string;
  now?: Date;
}): AirbnbHostStateClaims {
  const token = required(args.token, "OTA_AIRBNB_STATE_INVALID", 8192);
  const pieces = token.split(".");
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) {
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_STATE_INVALID");
  }
  const [encoded, suppliedSignature] = pieces;
  const expectedSignature = signPayload(encoded, stateSecret(args.secret));
  const supplied = Buffer.from(suppliedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_STATE_INVALID");
  }

  let claims: AirbnbHostStateClaims;
  try {
    claims = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as AirbnbHostStateClaims;
  } catch {
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_STATE_INVALID");
  }
  const nowMs = (args.now ?? new Date()).getTime();
  if (
    claims.version !== 1 ||
    typeof claims.issuedAt !== "number" ||
    typeof claims.expiresAt !== "number" ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt !== STATE_TTL_MS ||
    nowMs < claims.issuedAt - 60_000 ||
    nowMs > claims.expiresAt ||
    required(claims.organizationId, "OTA_AIRBNB_STATE_INVALID", 120) !==
      required(args.organizationId, "OTA_AIRBNB_STATE_TENANT_INVALID", 120) ||
    required(claims.requestedByUserId, "OTA_AIRBNB_STATE_INVALID", 120) !==
      required(args.requestedByUserId, "OTA_AIRBNB_STATE_ACTOR_INVALID", 120) ||
    !claims.propertyId ||
    !claims.nonce
  ) {
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_STATE_INVALID");
  }
  return claims;
}

function parseConnectionLinkUrl(payload: unknown): string {
  const root = record(payload);
  const data = record(root?.data);
  const attributes = record(data?.attributes);
  const rawUrl = attributes?.url;
  try {
    if (typeof rawUrl !== "string") throw new Error("invalid");
    const parsed = new URL(rawUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error("invalid");
    }
    // Channex returns the Airbnb authorization page, not its API origin.
    // Keep HTTPS/credential guards without rewriting the provider's URL.
    return rawUrl;
  } catch {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_CONNECTION_LINK_RESPONSE_INVALID"
    );
  }
}

async function loadReadyDistributionProperty(args: {
  client: AirbnbHostSelfServiceClient;
  organizationId: string;
  propertyId: string;
}) {
  const distributionProperty = await args.client.distributionProperty.findFirst({
    where: {
      organizationId: args.organizationId,
      propertyId: args.propertyId,
      platform: "CHANNEX",
    },
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
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_PROPERTY_NOT_PROVISIONED");
  }
  if (
    distributionProperty.organizationId !== args.organizationId ||
    distributionProperty.propertyId !== args.propertyId ||
    distributionProperty.platform !== "CHANNEX" ||
    distributionProperty.provisioningStatus !== "READY" ||
    !distributionProperty.group ||
    distributionProperty.group.organizationId !== args.organizationId ||
    distributionProperty.group.platform !== "CHANNEX" ||
    distributionProperty.group.provisioningStatus !== "READY"
  ) {
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_PROVISIONING_NOT_READY");
  }
  return distributionProperty;
}

export async function issueAirbnbHostConnectionLink(args: {
  client: AirbnbHostSelfServiceClient;
  transport: AirbnbHostSelfServiceTransport;
  stateSecret: string;
  callbackOrigin: string;
  providerOrigin: string;
  organizationId: string;
  propertyId: string;
  requestedByUserId: string;
  now?: Date;
}): Promise<{ authorizationUrl: string; expiresAt: Date }> {
  const organizationId = required(args.organizationId, "OTA_AIRBNB_TENANT_INVALID", 120);
  const propertyId = required(args.propertyId, "OTA_AIRBNB_PROPERTY_INVALID", 120);
  const requestedByUserId = required(
    args.requestedByUserId,
    "OTA_AIRBNB_ACTOR_INVALID",
    120
  );
  const callbackOrigin = exactHttpsOrigin(
    args.callbackOrigin,
    "OTA_AIRBNB_CALLBACK_ORIGIN_INVALID"
  );
  exactHttpsOrigin(
    args.providerOrigin,
    "OTA_AIRBNB_PROVIDER_ORIGIN_INVALID"
  );
  const distributionProperty = await loadReadyDistributionProperty({
    client: args.client,
    organizationId,
    propertyId,
  });

  const externalGroupId = requiredUuid(
    distributionProperty.group!.externalGroupId,
    "OTA_AIRBNB_EXTERNAL_GROUP_ID_INVALID"
  );
  const externalPropertyId = requiredUuid(
    distributionProperty.externalPropertyId,
    "OTA_AIRBNB_EXTERNAL_PROPERTY_ID_INVALID"
  );
  const state = createAirbnbHostState({
    secret: args.stateSecret,
    organizationId,
    propertyId,
    requestedByUserId,
    now: args.now,
  });
  const callbackUrl = `${callbackOrigin}/distribution/airbnb/callback`;
  const response = await args.transport.createConnectionLink({
    connection_link: {
      group_id: externalGroupId,
      properties: [externalPropertyId],
      redirect_uri: callbackUrl,
      failure_redirect_uri: callbackUrl,
      token: state,
    },
  });

  const now = args.now ?? new Date();
  return {
    authorizationUrl: parseConnectionLinkUrl(response),
    expiresAt: new Date(now.getTime() + STATE_TTL_MS),
  };
}

export async function verifyAirbnbHostCallback(args: {
  client: AirbnbHostSelfServiceClient;
  transport: AirbnbHostSelfServiceTransport;
  stateSecret: string;
  organizationId: string;
  requestedByUserId: string;
  success: string;
  channelId?: string | null;
  token?: string | null;
  now?: Date;
}): Promise<{
  success: boolean;
  propertyId: string | null;
  channelId: string | null;
  channelActive: boolean | null;
  airbnbAccountVerified: false;
  nextAction: "RETRY_AUTHORIZATION" | "LISTING_DISCOVERY_REQUIRED";
}> {
  // Failure redirects only guarantee success=false, not a token or channel.
  // This is an uncorrelated UI result: no tenant/property inference or effects.
  if (args.success === "false") {
    return {
      success: false,
      propertyId: null,
      channelId: null,
      channelActive: null,
      airbnbAccountVerified: false,
      nextAction: "RETRY_AUTHORIZATION",
    };
  }
  if (args.success !== "true") {
    throw new AirbnbHostSelfServiceError("OTA_AIRBNB_CALLBACK_RESULT_INVALID");
  }
  const claims = verifyAirbnbHostState({
    token: required(args.token, "OTA_AIRBNB_STATE_INVALID", 8192),
    secret: args.stateSecret,
    organizationId: args.organizationId,
    requestedByUserId: args.requestedByUserId,
    now: args.now,
  });

  const distributionProperty = await loadReadyDistributionProperty({
    client: args.client,
    organizationId: claims.organizationId,
    propertyId: claims.propertyId,
  });
  const channelId = requiredUuid(
    args.channelId,
    "OTA_AIRBNB_CHANNEL_ID_INVALID"
  );
  const expectedPropertyId = requiredUuid(
    distributionProperty.externalPropertyId,
    "OTA_AIRBNB_EXTERNAL_PROPERTY_ID_INVALID"
  );
  const expectedGroupId = requiredUuid(
    distributionProperty.group!.externalGroupId,
    "OTA_AIRBNB_EXTERNAL_GROUP_ID_INVALID"
  );
  let verification;
  try {
    verification = verifyAirbnbCallbackChannelResource({
      payload: await args.transport.getChannel(channelId),
      expectedChannelId: channelId,
      expectedPropertyId,
      expectedGroupId,
    });
  } catch (error) {
    if (error instanceof AirbnbCallbackChannelVerificationError) {
      throw new AirbnbHostSelfServiceError(error.code);
    }
    throw error;
  }

  return {
    success: true,
    propertyId: claims.propertyId,
    channelId,
    channelActive: verification.activeState,
    airbnbAccountVerified: verification.airbnbAccountVerified,
    nextAction: "LISTING_DISCOVERY_REQUIRED",
  };
}
