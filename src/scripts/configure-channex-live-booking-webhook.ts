import "dotenv/config";
import axios from "axios";
import { pathToFileURL } from "node:url";
import { PmsProvider } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  assertVerifiedChannexWebhook,
  buildChannexBookingWebhookPayload,
  normalizeChannexWebhookCallbackUrl,
} from "../services/channex-booking-webhook-registration.service";
import { generateChannexWebhookSecret } from "../pms/ingest/channex-webhook-auth";

const REQUIRED_CONFIRMATION = "CONFIGURE_CHANNEX_LIVE_WEBHOOK";
const CHANNEX_WEBHOOK_EVENT_MASK = "booking";
const CHANNEX_WEBHOOK_SEND_DATA = false;
const CHANNEX_REQUEST_TIMEOUT_MS = 20_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function requiredEnv(name: string) {
  const value = String(process.env[name] ?? "").trim();

  if (!value) {
    throw new Error(`${name}_REQUIRED`);
  }

  return value;
}

export function normalizeChannexLiveBaseUrl(value: string) {
  const url = new URL(String(value ?? "").trim());

  if (url.protocol !== "https:") {
    throw new Error("CHANNEX_LIVE_WEBHOOK_REQUIRES_HTTPS");
  }

  if (url.hostname === "staging.channex.io") {
    throw new Error("CHANNEX_LIVE_WEBHOOK_REJECTS_STAGING");
  }

  if (
    url.hostname !== "channex.io" &&
    !url.hostname.endsWith(".channex.io")
  ) {
    throw new Error("CHANNEX_LIVE_WEBHOOK_REQUIRES_CHANNEX_HOST");
  }

  return url.toString().replace(/\/+$/, "");
}

export function normalizeChannexLiveWebhookCallbackUrl(value: string) {
  const callbackUrl = normalizeChannexWebhookCallbackUrl(value);
  const url = new URL(callbackUrl);

  if (url.hostname !== "api.pin-ngo.com") {
    throw new Error("CHANNEX_LIVE_WEBHOOK_CALLBACK_MUST_BE_PRODUCTION_API");
  }

  return callbackUrl;
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

export async function configureChannexBookingWebhookForLive(args: {
  propertyId: string;
  callbackUrl: string;
  apiKey: string;
  apiBaseUrl: string;
}) {
  const propertyId = String(args.propertyId ?? "").trim();
  const apiKey = String(args.apiKey ?? "").trim();

  if (!propertyId) {
    throw new Error("PIN_GO_PROPERTY_ID_REQUIRED");
  }

  if (!apiKey) {
    throw new Error("CHANNEX_API_KEY_REQUIRED");
  }

  const apiBaseUrl = normalizeChannexLiveBaseUrl(args.apiBaseUrl);
  const callbackUrl = normalizeChannexLiveWebhookCallbackUrl(args.callbackUrl);

  const listings = await prisma.pmsListing.findMany({
    where: {
      propertyId,
      connection: {
        is: {
          provider: PmsProvider.CHANNEX,
          status: "ACTIVE",
        },
      },
    },
    include: {
      connection: {
        select: {
          id: true,
          webhookSecret: true,
        },
      },
    },
    take: 100,
  });

  if (listings.length === 0) {
    throw new Error("CHANNEX_PROPERTY_MAPPING_NOT_FOUND");
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
  const webhookSecret = existingSecret ?? generateChannexWebhookSecret();

  if (!existingSecret) {
    await prisma.pmsConnection.update({
      where: { id: connection.id },
      data: { webhookSecret },
    });
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
      }
    );

    const root = asRecord(response.data);
    const data = asRecord(root.data);
    webhookId = asString(data.id) ?? asString(root.id);

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
    environment: "LIVE",
    operation,
    propertyId,
    channexPropertyId,
    webhookId,
    callbackUrl,
    eventMask: CHANNEX_WEBHOOK_EVENT_MASK,
    sendData: CHANNEX_WEBHOOK_SEND_DATA,
    isActive: true,
    secretCreated: !existingSecret,
    verified: true,
  };
}

async function main() {
  const confirmation = requiredEnv("CHANNEX_LIVE_WEBHOOK_CONFIRMATION");

  if (confirmation !== REQUIRED_CONFIRMATION) {
    throw new Error("CHANNEX_LIVE_WEBHOOK_CONFIRMATION_INVALID");
  }

  const result = await configureChannexBookingWebhookForLive({
    propertyId: requiredEnv("PIN_GO_PROPERTY_ID"),
    callbackUrl: requiredEnv("CHANNEX_WEBHOOK_CALLBACK_URL"),
    apiKey: requiredEnv("CHANNEX_API_KEY"),
    apiBaseUrl: requiredEnv("CHANNEX_API_BASE_URL"),
  });

  console.log("[channex.live.booking-webhook] configured", result);
}

function direct() {
  try {
    return Boolean(process.argv[1]) &&
      pathToFileURL(process.argv[1]!).href === import.meta.url;
  } catch {
    return false;
  }
}

if (direct()) {
  main()
    .catch((error) => {
      console.error("[channex.live.booking-webhook] failed", {
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}