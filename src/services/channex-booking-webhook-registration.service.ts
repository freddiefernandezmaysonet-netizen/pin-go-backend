import axios from "axios";
import { PmsProvider } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  CHANNEX_PRODUCTION_API_ORIGIN,
  isProductionRuntime,
  resolveChannexRuntimeTransport,
} from "../lib/channex-runtime-transport.policy";
import {
  CHANNEX_WEBHOOK_SECRET_HEADER,
  generateChannexWebhookSecret,
} from "../pms/ingest/channex-webhook-auth";

const CHANNEX_WEBHOOK_EVENT_MASK = "booking";
const CHANNEX_WEBHOOK_SEND_DATA = false;
const CHANNEX_REQUEST_TIMEOUT_MS = 20_000;
export const CHANNEX_PRODUCTION_WEBHOOK_CALLBACK_URL =
  "https://api.pin-ngo.com/webhooks/channex";

type RegistrationEnvironment = Readonly<Record<string, string | undefined>>;
type RegistrationScope = {
  propertyId: string;
  organizationId?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeChannexStagingBaseUrl(value: string) {
  const url = new URL(String(value ?? "").trim());

  if (url.protocol !== "https:" || url.hostname !== "staging.channex.io") {
    throw new Error("CHANNEX_WEBHOOK_REGISTRATION_REQUIRES_STAGING");
  }

  return url.toString().replace(/\/+$/, "");
}

export function normalizeChannexWebhookCallbackUrl(value: string) {
  const url = new URL(String(value ?? "").trim());

  if (url.protocol !== "https:") {
    throw new Error("CHANNEX_WEBHOOK_CALLBACK_REQUIRES_HTTPS");
  }

  if (!url.pathname.endsWith("/webhooks/channex")) {
    throw new Error("CHANNEX_WEBHOOK_CALLBACK_PATH_INVALID");
  }

  return url.toString().replace(/\/+$/, "");
}

export function normalizeChannexLiveBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw new Error("CHANNEX_PRODUCTION_OTA_ORIGIN_REQUIRED");
  }
  if (url.protocol !== "https:") {
    throw new Error("CHANNEX_LIVE_WEBHOOK_REQUIRES_HTTPS");
  }
  if (url.hostname === "staging.channex.io") {
    throw new Error("CHANNEX_LIVE_WEBHOOK_REJECTS_STAGING");
  }
  if (
    url.origin !== CHANNEX_PRODUCTION_API_ORIGIN ||
    url.pathname !== "/" || url.username || url.password || url.search || url.hash
  ) {
    throw new Error("CHANNEX_PRODUCTION_OTA_ORIGIN_REQUIRED");
  }
  return url.origin;
}

export function normalizeChannexLiveWebhookCallbackUrl(value: string) {
  const callbackUrl = normalizeChannexWebhookCallbackUrl(value);
  if (callbackUrl !== CHANNEX_PRODUCTION_WEBHOOK_CALLBACK_URL) {
    throw new Error("CHANNEX_LIVE_WEBHOOK_CALLBACK_MUST_BE_PRODUCTION_API");
  }
  return callbackUrl;
}

export function buildChannexBookingWebhookPayload(args: {
  channexPropertyId: string;
  callbackUrl: string;
  webhookSecret: string;
}) {
  return {
    webhook: {
      property_id: args.channexPropertyId,
      callback_url: args.callbackUrl,
      event_mask: CHANNEX_WEBHOOK_EVENT_MASK,
      headers: {
        [CHANNEX_WEBHOOK_SECRET_HEADER]: args.webhookSecret,
      },
      is_active: true,
      send_data: CHANNEX_WEBHOOK_SEND_DATA,
    },
  };
}

function getChannexWebhookId(responseData: unknown) {
  const root = asRecord(responseData);
  const data = asRecord(root.data);
  return asString(data.id) ?? asString(root.id);
}

function getChannexWebhookAttributes(responseData: unknown) {
  const root = asRecord(responseData);
  const data = asRecord(root.data);
  return asRecord(data.attributes ?? root.attributes);
}

function getChannexWebhookPropertyId(responseData: unknown) {
  const root = asRecord(responseData);
  const data = asRecord(root.data);
  const attributes = asRecord(data.attributes ?? root.attributes);
  const relationships = asRecord(data.relationships ?? root.relationships);
  const propertyRelationship = asRecord(relationships.property);
  const propertyData = asRecord(propertyRelationship.data);

  return (
    asString(attributes.property_id) ??
    asString(asRecord(attributes.property).id) ??
    asString(propertyData.id) ??
    asString(data.property_id) ??
    asString(root.property_id)
  );
}

export function assertVerifiedChannexWebhook(args: {
  responseData: unknown;
  webhookId: string;
  callbackUrl: string;
  channexPropertyId: string;
}) {
  const responseWebhookId = getChannexWebhookId(args.responseData);
  const attributes = getChannexWebhookAttributes(args.responseData);
  const callbackUrl = asString(attributes.callback_url);
  const propertyId = getChannexWebhookPropertyId(args.responseData);
  const eventMask = asString(attributes.event_mask);
  const isActive = attributes.is_active;
  const sendData = attributes.send_data;

  if (!responseWebhookId) {
    throw new Error("CHANNEX_WEBHOOK_VERIFICATION_ID_MISSING");
  }

  if (responseWebhookId !== args.webhookId) {
    throw new Error("CHANNEX_WEBHOOK_VERIFICATION_ID_MISMATCH");
  }

  if (!callbackUrl) {
    throw new Error("CHANNEX_WEBHOOK_VERIFICATION_CALLBACK_MISSING");
  }

  if (callbackUrl !== args.callbackUrl) {
    throw new Error("CHANNEX_WEBHOOK_VERIFICATION_CALLBACK_MISMATCH");
  }

  if (!propertyId) {
    throw new Error("CHANNEX_WEBHOOK_VERIFICATION_PROPERTY_MISSING");
  }

  if (propertyId !== args.channexPropertyId) {
    throw new Error("CHANNEX_WEBHOOK_VERIFICATION_PROPERTY_MISMATCH");
  }

  if (!eventMask) {
    throw new Error("CHANNEX_WEBHOOK_VERIFICATION_EVENT_MASK_MISSING");
  }

  if (eventMask !== CHANNEX_WEBHOOK_EVENT_MASK) {
    throw new Error("CHANNEX_WEBHOOK_VERIFICATION_EVENT_MASK_MISMATCH");
  }

  if (isActive !== true) {
    throw new Error("CHANNEX_WEBHOOK_VERIFICATION_INACTIVE");
  }

  if (sendData !== false) {
    throw new Error("CHANNEX_WEBHOOK_VERIFICATION_SEND_DATA_ENABLED");
  }
}

async function persistWebhookMetadata(args: {
  listings: Array<{
    id: string;
    metadata: unknown;
  }>;
  webhookId: string;
  callbackUrl: string;
  verified: boolean;
}) {
  const configuredAt = new Date().toISOString();

  await Promise.all(
    args.listings.map((listing) =>
      prisma.pmsListing.update({
        where: { id: listing.id },
        data: {
          metadata: {
            ...asRecord(listing.metadata),
            channexBookingWebhookId: args.webhookId,
            channexBookingWebhookEventMask: CHANNEX_WEBHOOK_EVENT_MASK,
            channexBookingWebhookSendData: CHANNEX_WEBHOOK_SEND_DATA,
            channexBookingWebhookCallbackUrl: args.callbackUrl,
            channexBookingWebhookVerified: args.verified,
            channexBookingWebhookConfiguredAt: configuredAt,
          },
        },
      })
    )
  );
}

// Both entry points share the certified POST/PUT -> GET -> verified flow.
async function configureChannexBookingWebhook(args: RegistrationScope & {
  callbackUrl: string;
  apiKey: string;
  apiBaseUrl: string;
  environment: "STAGING" | "LIVE";
}) {
  const propertyId = String(args.propertyId ?? "").trim();
  const apiKey = String(args.apiKey ?? "").trim();

  if (!propertyId) {
    throw new Error("PIN_GO_PROPERTY_ID_REQUIRED");
  }

  if (!apiKey) {
    throw new Error("CHANNEX_API_KEY_REQUIRED");
  }

  const apiBaseUrl = args.apiBaseUrl;
  const callbackUrl = args.callbackUrl;
  const organizationId = args.organizationId === undefined
    ? undefined
    : asString(args.organizationId);
  if (organizationId === null) {
    throw new Error("CHANNEX_WEBHOOK_ORGANIZATION_ID_REQUIRED");
  }

  const listings = await prisma.pmsListing.findMany({
    where: {
      propertyId,
      connection: {
        is: {
          provider: PmsProvider.CHANNEX,
          status: "ACTIVE",
          ...(organizationId ? { organizationId } : {}),
        },
      },
    },
    include: {
      connection: {
        select: {
          id: true,
          organizationId: true,
          webhookSecret: true,
        },
      },
    },
    take: 100,
  });

  if (listings.length === 0) {
    throw new Error("CHANNEX_PROPERTY_MAPPING_NOT_FOUND");
  }

  if (organizationId && listings.some(
    (listing) => listing.connection.organizationId !== organizationId
  )) {
    throw new Error("CHANNEX_WEBHOOK_TENANT_MISMATCH");
  }

  const connectionIds = Array.from(
    new Set(listings.map((listing) => listing.connection.id))
  );

  if (connectionIds.length !== 1) {
    throw new Error("CHANNEX_PROPERTY_MAPPING_AMBIGUOUS");
  }

  const mappedPropertyIds = Array.from(
    new Set(
      listings
        .map((item) => asString(asRecord(item.metadata).channexPropertyId))
        .filter((value): value is string => Boolean(value))
    )
  );

  if (
    mappedPropertyIds.length !== 1 ||
    listings.some(
      (item) => !asString(asRecord(item.metadata).channexPropertyId)
    )
  ) {
    throw new Error(
      mappedPropertyIds.length > 1
        ? "CHANNEX_PROPERTY_MAPPING_AMBIGUOUS"
        : "CHANNEX_PROPERTY_ID_MISSING_FROM_LISTING"
    );
  }

  const channexPropertyId = mappedPropertyIds[0]!;
  const existingWebhookIds = Array.from(
    new Set(
      listings
        .map((item) =>
          asString(asRecord(item.metadata).channexBookingWebhookId)
        )
        .filter((value): value is string => Boolean(value))
    )
  );

  if (existingWebhookIds.length > 1) {
    throw new Error("CHANNEX_WEBHOOK_MAPPING_AMBIGUOUS");
  }

  const existingWebhookId = existingWebhookIds[0] ?? null;
  const connection = listings[0]!.connection;
  const existingSecret = asString(connection.webhookSecret);
  let webhookSecret = existingSecret;
  let secretCreated = false;

  if (!webhookSecret) {
    const candidateSecret = generateChannexWebhookSecret();
    // An organization shares one PMS connection across properties. Claim the
    // absent value atomically: concurrent onboarding must not rotate a secret
    // already selected by another property's registration.
    const claimed = await prisma.pmsConnection.updateMany({
      where: {
        id: connection.id,
        organizationId: connection.organizationId,
        provider: PmsProvider.CHANNEX,
        status: "ACTIVE",
        webhookSecret: connection.webhookSecret,
      },
      data: { webhookSecret: candidateSecret },
    });
    if (claimed.count === 1) {
      webhookSecret = candidateSecret;
      secretCreated = true;
    } else if (claimed.count === 0) {
      const current = await prisma.pmsConnection.findUnique({
        where: { id: connection.id },
        select: {
          organizationId: true,
          provider: true,
          status: true,
          webhookSecret: true,
        },
      });
      if (
        !current || current.organizationId !== connection.organizationId ||
        current.provider !== PmsProvider.CHANNEX || current.status !== "ACTIVE"
      ) {
        throw new Error("CHANNEX_WEBHOOK_SECRET_PERSISTENCE_CONFLICT");
      }
      webhookSecret = asString(current.webhookSecret);
      if (!webhookSecret) {
        throw new Error("CHANNEX_WEBHOOK_SECRET_PERSISTENCE_CONFLICT");
      }
    } else {
      throw new Error("CHANNEX_WEBHOOK_SECRET_PERSISTENCE_CONFLICT");
    }
  }

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "user-api-key": apiKey,
  };
  const payload = buildChannexBookingWebhookPayload({
    channexPropertyId,
    callbackUrl,
    webhookSecret,
  });

  let webhookId = existingWebhookId;
  let operation: "CREATED" | "UPDATED" | "RECREATED";

  if (webhookId) {
    try {
      await axios.put(
        `${apiBaseUrl}/api/v1/webhooks/${encodeURIComponent(webhookId)}`,
        payload,
        {
          headers,
          timeout: CHANNEX_REQUEST_TIMEOUT_MS,
          maxRedirects: 0,
        }
      );
      operation = "UPDATED";

      await persistWebhookMetadata({
        listings,
        webhookId,
        callbackUrl,
        verified: false,
      });
    } catch (error: any) {
      if (error?.response?.status !== 404) {
        throw error;
      }

      webhookId = null;
      operation = "RECREATED";
    }
  } else {
    operation = "CREATED";
  }

  if (!webhookId) {
    const response = await axios.post(
      `${apiBaseUrl}/api/v1/webhooks`,
      payload,
      {
        headers,
        timeout: CHANNEX_REQUEST_TIMEOUT_MS,
        maxRedirects: 0,
      }
    );

    webhookId = getChannexWebhookId(response.data);

    if (!webhookId) {
      throw new Error("CHANNEX_WEBHOOK_CREATE_RESPONSE_INVALID");
    }

    await persistWebhookMetadata({
      listings,
      webhookId,
      callbackUrl,
      verified: false,
    });
  }

  const verification = await axios.get(
    `${apiBaseUrl}/api/v1/webhooks/${encodeURIComponent(webhookId)}`,
    {
      headers,
      timeout: CHANNEX_REQUEST_TIMEOUT_MS,
      maxRedirects: 0,
    }
  );

  assertVerifiedChannexWebhook({
    responseData: verification.data,
    webhookId,
    callbackUrl,
    channexPropertyId,
  });

  await persistWebhookMetadata({
    listings,
    webhookId,
    callbackUrl,
    verified: true,
  });

  return {
    ok: true,
    provider: "PIN_GO_CONNECT",
    environment: args.environment,
    operation,
    propertyId,
    channexPropertyId,
    webhookId,
    callbackUrl,
    eventMask: CHANNEX_WEBHOOK_EVENT_MASK,
    sendData: CHANNEX_WEBHOOK_SEND_DATA,
    isActive: true,
    secretCreated,
    verified: true,
  };
}

// Retain the certified staging command and its public contract.
export async function configureChannexBookingWebhookForStaging(args: {
  propertyId: string;
  callbackUrl: string;
  apiKey: string;
  apiBaseUrl: string;
}) {
  return configureChannexBookingWebhook({
    ...args,
    apiBaseUrl: normalizeChannexStagingBaseUrl(args.apiBaseUrl),
    callbackUrl: normalizeChannexWebhookCallbackUrl(args.callbackUrl),
    environment: "STAGING",
  });
}

export async function configureChannexBookingWebhookForLive(
  args: RegistrationScope & { env?: RegistrationEnvironment }
) {
  // The live command is productive even when NODE_ENV is absent. This is a
  // configuration view, not a process.env mutation; legacy credentials cannot
  // become a fallback or override an explicitly configured OTA transport.
  const transport = resolveChannexRuntimeTransport({
    env: { ...(args.env ?? process.env), NODE_ENV: "production" },
  });
  return configureChannexBookingWebhook({
    propertyId: args.propertyId,
    organizationId: args.organizationId,
    apiKey: transport.apiKey,
    apiBaseUrl: normalizeChannexLiveBaseUrl(transport.apiOrigin),
    callbackUrl: CHANNEX_PRODUCTION_WEBHOOK_CALLBACK_URL,
    environment: "LIVE",
  });
}

export async function configureChannexBookingWebhookForConnectionCenter(args: {
  organizationId: string;
  propertyId: string;
  env?: RegistrationEnvironment;
}) {
  const organizationId = asString(args.organizationId);
  if (!organizationId) {
    throw new Error("CHANNEX_WEBHOOK_ORGANIZATION_ID_REQUIRED");
  }
  const env = args.env ?? process.env;
  let configuredOrigin: string | null = null;
  try {
    configuredOrigin = new URL(env.OTA_CONNECTION_PROVIDER_API_ORIGIN ?? "").origin;
  } catch {
    // The transport resolver below rejects missing or malformed configuration.
  }
  if (isProductionRuntime(env) || configuredOrigin === CHANNEX_PRODUCTION_API_ORIGIN) {
    return configureChannexBookingWebhookForLive({
      organizationId,
      propertyId: args.propertyId,
      env,
    });
  }

  // Keep staging certification isolated. Explicit empty values prevent the
  // shared resolver from falling back to CHANNEX_API_KEY/CHANNEX_API_BASE_URL.
  const transport = resolveChannexRuntimeTransport({
    env,
    nonProductionApiKey: env.OTA_CONNECTION_API_KEY ?? "",
    nonProductionApiOrigin: env.OTA_CONNECTION_PROVIDER_API_ORIGIN ?? "",
    nonProductionMissingApiKeyError: "OTA_CONNECTION_API_KEY_REQUIRED",
    nonProductionInvalidOriginError: "OTA_CONNECTION_PROVIDER_API_ORIGIN_REQUIRED",
  });
  return configureChannexBookingWebhook({
    organizationId,
    propertyId: args.propertyId,
    apiKey: transport.apiKey,
    apiBaseUrl: normalizeChannexStagingBaseUrl(transport.apiOrigin),
    callbackUrl: normalizeChannexWebhookCallbackUrl(env.CHANNEX_WEBHOOK_CALLBACK_URL ?? ""),
    environment: "STAGING",
  });
}
