import { PmsProvider } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  evaluateChannexStagingReadiness,
  type ChannexStagingListingReadiness,
} from "./channex-staging-readiness.policy";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function parseIntegerEnv(name: string, fallback: number) {
  const raw = String(process.env[name] ?? "").trim();

  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

function toListingReadiness(args: {
  externalListingId: string;
  metadata: unknown;
}): ChannexStagingListingReadiness {
  const metadata = asRecord(args.metadata);

  return {
    externalListingId: asString(args.externalListingId),
    channexPropertyId: asString(metadata.channexPropertyId),
    webhookId: asString(metadata.channexBookingWebhookId),
    webhookCallbackUrl: asString(
      metadata.channexBookingWebhookCallbackUrl
    ),
    webhookEventMask: asString(
      metadata.channexBookingWebhookEventMask
    ),
    webhookSendData:
      typeof metadata.channexBookingWebhookSendData === "boolean"
        ? metadata.channexBookingWebhookSendData
        : null,
    webhookConfiguredAt: asString(
      metadata.channexBookingWebhookConfiguredAt
    ),
  };
}

export async function getChannexStagingReadinessReport(args?: {
  propertyId?: string | null;
  callbackUrl?: string | null;
}) {
  const propertyId = asString(
    args?.propertyId ?? process.env.PIN_GO_PROPERTY_ID
  );
  const callbackUrl = asString(
    args?.callbackUrl ?? process.env.CHANNEX_WEBHOOK_CALLBACK_URL
  );

  let property: {
    id: string;
    status: string;
  } | null = null;
  let listings: Array<{
    externalListingId: string;
    metadata: unknown;
    connection: {
      id: string;
      status: string;
      webhookSecret: string | null;
    };
  }> = [];

  if (propertyId) {
    property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: {
        id: true,
        status: true,
      },
    });

    listings = await prisma.pmsListing.findMany({
      where: {
        propertyId,
        connection: {
          is: {
            provider: PmsProvider.CHANNEX,
          },
        },
      },
      select: {
        externalListingId: true,
        metadata: true,
        connection: {
          select: {
            id: true,
            status: true,
            webhookSecret: true,
          },
        },
      },
      orderBy: {
        externalListingId: "asc",
      },
    });
  }

  const connectionsById = new Map(
    listings.map((listing) => [listing.connection.id, listing.connection])
  );
  const activeConnections = Array.from(connectionsById.values()).filter(
    (connection) => connection.status === "ACTIVE"
  );
  const singleConnection =
    activeConnections.length === 1 ? activeConnections[0]! : null;

  const evaluated = evaluateChannexStagingReadiness({
    nodeEnv: asString(process.env.NODE_ENV),
    databaseConfigured: Boolean(asString(process.env.DATABASE_URL)),
    apiBaseUrl: asString(process.env.CHANNEX_API_BASE_URL),
    callbackUrl,
    propertyId,
    propertyFound: Boolean(property),
    propertyStatus: property?.status ?? null,
    connectionCount: activeConnections.length,
    connectionStatus: singleConnection?.status ?? null,
    webhookSecretPresent: Boolean(asString(singleConnection?.webhookSecret)),
    listings: listings.map(toListingReadiness),
    worker: {
      pollMs: parseIntegerEnv("PMS_WEBHOOK_RECOVERY_POLL_MS", 60_000),
      batchSize: parseIntegerEnv("PMS_WEBHOOK_RECOVERY_BATCH_SIZE", 20),
      maxAttempts: parseIntegerEnv("PMS_WEBHOOK_RECOVERY_MAX_ATTEMPTS", 8),
      pendingMinAgeMs: parseIntegerEnv(
        "PMS_WEBHOOK_RECOVERY_PENDING_MIN_AGE_MS",
        30_000
      ),
      retryDelayMs: parseIntegerEnv(
        "PMS_WEBHOOK_RECOVERY_RETRY_DELAY_MS",
        60_000
      ),
      staleProcessingMs: parseIntegerEnv(
        "PMS_WEBHOOK_RECOVERY_STALE_PROCESSING_MS",
        600_000
      ),
    },
  });

  return {
    ...evaluated,
    generatedAt: new Date().toISOString(),
    provider: "PIN_GO_CONNECT",
    environment: "STAGING",
    propertyId,
    callbackUrl,
    connectionCount: activeConnections.length,
    listingCount: listings.length,
  };
}
