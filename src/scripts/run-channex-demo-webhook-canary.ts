import "dotenv/config";
import { pathToFileURL } from "node:url";
import { prisma } from "../lib/prisma";
import {
  assertVerifiedChannexWebhook,
  buildChannexBookingWebhookPayload,
  normalizeChannexStagingBaseUrl,
  normalizeChannexWebhookCallbackUrl,
} from "../services/channex-booking-webhook-registration.service";
import { generateChannexWebhookSecret } from "../pms/ingest/channex-webhook-auth";

const CONFIRMATION = "RUN_CHANNEX_DEMO_WEBHOOK_CANARY";
const DEMO_LISTING_NAME = "Pin&Go Demo Property";
const DEFAULT_CALLBACK_URL = "https://api.pin-ngo.com/webhooks/channex";
const REQUEST_TIMEOUT_MS = 20_000;

type JsonRecord = Record<string, unknown>;

type CanaryDependencies = {
  prisma?: any;
  fetch?: typeof fetch;
  now?: () => Date;
  generateSecret?: () => string;
  log?: (value: unknown) => void;
  logError?: (value: unknown) => void;
  disconnect?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asString(value: unknown) {
  return String(value ?? "").trim();
}

function safeErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim();

  if (/^[A-Z0-9_:-]{1,200}$/.test(normalized)) {
    return normalized;
  }

  return "CHANNEX_DEMO_WEBHOOK_CANARY_FAILED";
}

function printJson(log: (value: unknown) => void, value: unknown) {
  log(JSON.stringify(value, null, 2));
}

function headers(apiKey: string) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "user-api-key": apiKey,
  };
}

async function readJsonResponse(response: Response) {
  const text = await response.text();

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function getWebhookId(responseData: unknown) {
  const root = asRecord(responseData);
  const data = asRecord(root.data);
  return asString(data.id) || asString(root.id);
}

function findEventId(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null;

  if (typeof value === "string") {
    try {
      return findEventId(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEventId(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === "object") {
    const record = value as JsonRecord;
    const explicit = asString(record.eventId) || asString(record.event_id);
    if (explicit) return explicit;

    for (const nested of Object.values(record)) {
      const found = findEventId(nested, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function validateEnv(env: NodeJS.ProcessEnv) {
  const confirmation = asString(
    env.CHANNEX_DEMO_WEBHOOK_CANARY_CONFIRMATION
  );

  if (confirmation !== CONFIRMATION) {
    throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_CONFIRMATION_REQUIRED");
  }

  const apiKey = asString(env.CHANNEX_API_KEY);
  if (!apiKey) throw new Error("CHANNEX_API_KEY_REQUIRED");

  const apiBaseUrl = normalizeChannexStagingBaseUrl(
    asString(env.CHANNEX_API_BASE_URL || "https://staging.channex.io")
  );

  const callbackUrl = normalizeChannexWebhookCallbackUrl(
    asString(env.CHANNEX_DEMO_WEBHOOK_CANARY_CALLBACK_URL || DEFAULT_CALLBACK_URL)
  );

  if (new URL(callbackUrl).hostname !== "api.pin-ngo.com") {
    throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_CALLBACK_MUST_BE_PRODUCTION_API");
  }

  return { apiKey, apiBaseUrl, callbackUrl };
}

async function fetchJsonWithTimeout(args: {
  fetchImpl: typeof fetch;
  url: string;
  init: RequestInit;
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await args.fetchImpl(args.url, {
      ...args.init,
      signal: controller.signal,
    });
    const body = await readJsonResponse(response);
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

async function findDemoListing(prismaClient: any) {
  const listings = await prismaClient.pmsListing.findMany({
    where: {
      name: DEMO_LISTING_NAME,
      connection: {
        is: {
          provider: "CHANNEX",
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
    take: 2,
  });

  if (listings.length === 0) {
    throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_LISTING_NOT_FOUND");
  }

  if (listings.length > 1) {
    throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_LISTING_AMBIGUOUS");
  }

  const listing = listings[0]!;
  const channexPropertyId = asString(asRecord(listing.metadata).channexPropertyId);

  if (!channexPropertyId) {
    throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_CHANNEX_PROPERTY_ID_MISSING");
  }

  return { listing, channexPropertyId };
}

async function findSyntheticEvent(args: {
  prismaClient: any;
  connectionId: string;
  channexPropertyId: string;
  startedAt: Date;
  eventId: string | null;
  sleep: (ms: number) => Promise<void>;
}) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (args.eventId) {
      const found = await args.prismaClient.webhookEventIngest.findUnique({
        where: { id: args.eventId },
        select: {
          id: true,
          connectionId: true,
          provider: true,
          eventType: true,
          status: true,
          attempts: true,
          createdAt: true,
          payloadRaw: true,
        },
      });

      if (found) return found;
    }

    const rows = await args.prismaClient.webhookEventIngest.findMany({
      where: {
        connectionId: args.connectionId,
        provider: "CHANNEX",
        createdAt: { gte: args.startedAt },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        connectionId: true,
        provider: true,
        eventType: true,
        status: true,
        attempts: true,
        createdAt: true,
        payloadRaw: true,
      },
    });

    const matches = rows.filter((row: any) => {
      const payload = asRecord(row.payloadRaw);
      return (
        asString(payload.property_id) === args.channexPropertyId ||
        asString(payload.propertyId) === args.channexPropertyId
      );
    });

    if (matches.length > 1) {
      throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_SYNTHETIC_EVENT_AMBIGUOUS");
    }

    if (matches.length === 1) return matches[0]!;

    await args.sleep(500);
  }

  return null;
}

export async function runChannexDemoWebhookCanary(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: CanaryDependencies = {}
) {
  const prismaClient = dependencies.prisma ?? prisma;
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => new Date());
  const generateSecret = dependencies.generateSecret ?? generateChannexWebhookSecret;
  const log = dependencies.log ?? console.log;
  const logError = dependencies.logError ?? console.error;
  const disconnect = dependencies.disconnect ?? (() => prisma.$disconnect());
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let remoteWebhookId: string | null = null;
  let syntheticEventId: string | null = null;
  let listingId: string | null = null;
  let connectionId: string | null = null;
  let originalMetadata: unknown = null;
  let originalWebhookSecret: string | null = null;
  let startedAt: Date | null = null;

  try {
    const { apiKey, apiBaseUrl, callbackUrl } = validateEnv(env);
    const { listing, channexPropertyId } = await findDemoListing(prismaClient);
    listingId = listing.id;
    connectionId = listing.connection.id;
    originalMetadata = listing.metadata;
    originalWebhookSecret = listing.connection.webhookSecret ?? null;

    const reservationCountBefore = await prismaClient.reservation.count();
    const webhookSecret = generateSecret();
    const requestHeaders = headers(apiKey);
    const payload = buildChannexBookingWebhookPayload({
      channexPropertyId,
      callbackUrl,
      webhookSecret,
    });

    const createResult = await fetchJsonWithTimeout({
      fetchImpl,
      url: `${apiBaseUrl}/api/v1/webhooks`,
      init: {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(payload),
      },
    });

    if (!createResult.response.ok) {
      throw new Error(`CHANNEX_DEMO_WEBHOOK_CANARY_CREATE_FAILED:${createResult.response.status}`);
    }

    remoteWebhookId = getWebhookId(createResult.body);
    if (!remoteWebhookId) {
      throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_CREATE_RESPONSE_INVALID");
    }

    const verifyResult = await fetchJsonWithTimeout({
      fetchImpl,
      url: `${apiBaseUrl}/api/v1/webhooks/${encodeURIComponent(remoteWebhookId)}`,
      init: {
        method: "GET",
        headers: requestHeaders,
      },
    });

    if (!verifyResult.response.ok) {
      throw new Error(`CHANNEX_DEMO_WEBHOOK_CANARY_VERIFY_FETCH_FAILED:${verifyResult.response.status}`);
    }

    assertVerifiedChannexWebhook({
      responseData: verifyResult.body,
      webhookId: remoteWebhookId,
      callbackUrl,
      channexPropertyId,
    });

    await prismaClient.pmsConnection.update({
      where: { id: connectionId },
      data: { webhookSecret },
    });

    await prismaClient.pmsListing.update({
      where: { id: listingId },
      data: {
        metadata: {
          ...asRecord(originalMetadata),
          channexBookingWebhookId: remoteWebhookId,
          channexBookingWebhookEventMask: "booking",
          channexBookingWebhookSendData: false,
          channexBookingWebhookCallbackUrl: callbackUrl,
          channexBookingWebhookVerified: true,
          channexBookingWebhookConfiguredAt: now().toISOString(),
        },
      },
    });

    startedAt = now();
    const testResult = await fetchJsonWithTimeout({
      fetchImpl,
      url: `${apiBaseUrl}/api/v1/webhooks/test`,
      init: {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({ callback_url: callbackUrl }),
      },
    });

    if (!testResult.response.ok) {
      throw new Error(`CHANNEX_DEMO_WEBHOOK_CANARY_TEST_CALLBACK_FAILED:${testResult.response.status}`);
    }

    const syntheticEvent = await findSyntheticEvent({
      prismaClient,
      connectionId,
      channexPropertyId,
      startedAt,
      eventId: findEventId(testResult.body),
      sleep,
    });

    if (!syntheticEvent) {
      throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_SYNTHETIC_EVENT_NOT_FOUND");
    }

    syntheticEventId = syntheticEvent.id;

    if (
      syntheticEvent.connectionId !== connectionId ||
      syntheticEvent.provider !== "CHANNEX" ||
      syntheticEvent.status !== "PENDING" ||
      syntheticEvent.attempts !== 0 ||
      syntheticEvent.createdAt < startedAt
    ) {
      throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_SYNTHETIC_EVENT_INVALID");
    }

    const deleted = await prismaClient.webhookEventIngest.deleteMany({
      where: {
        id: syntheticEventId,
        status: "PENDING",
        attempts: 0,
        createdAt: { gte: startedAt },
      },
    });

    if (deleted.count !== 1) {
      throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_SYNTHETIC_EVENT_CLEANUP_FAILED");
    }

    syntheticEventId = null;
    const reservationCountAfter = await prismaClient.reservation.count();

    if (reservationCountAfter !== reservationCountBefore) {
      throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_RESERVATION_DELTA_DETECTED");
    }

    printJson(log, {
      provider: "PIN_GO_CONNECT",
      executionMode: "CHANNEX_DEMO_WEBHOOK_CANARY",
      status: "PASS",
      property: {
        listingName: DEMO_LISTING_NAME,
        propertyId: listing.propertyId,
        channexPropertyId,
      },
      callback: {
        host: new URL(callbackUrl).hostname,
        path: new URL(callbackUrl).pathname,
      },
      remoteWebhookVerified: true,
      syntheticEventStoredAsPending: true,
      syntheticEventDeleted: true,
      reservationDelta: 0,
      workersActivated: false,
      appChannexTouched: false,
    });

    return 0;
  } catch (error) {
    printJson(logError, {
      provider: "PIN_GO_CONNECT",
      executionMode: "CHANNEX_DEMO_WEBHOOK_CANARY",
      status: "FAILED_SAFE",
      errorCode: safeErrorCode(error),
      syntheticEventCleanupAttempted: Boolean(syntheticEventId),
      remoteWebhookCleanupAttempted: Boolean(remoteWebhookId),
      workersActivated: false,
      appChannexTouched: false,
    });

    return 1;
  } finally {
    if (syntheticEventId && startedAt) {
      await prismaClient.webhookEventIngest
        .deleteMany({
          where: {
            id: syntheticEventId,
            status: "PENDING",
            attempts: 0,
            createdAt: { gte: startedAt },
          },
        })
        .catch(() => undefined);
    }

    const envApiKey = asString(env.CHANNEX_API_KEY);
    const envBase = asString(env.CHANNEX_API_BASE_URL || "https://staging.channex.io");

    if (remoteWebhookId && envApiKey) {
      try {
        const apiBaseUrl = normalizeChannexStagingBaseUrl(envBase);
        await fetchImpl(`${apiBaseUrl}/api/v1/webhooks/${encodeURIComponent(remoteWebhookId)}`, {
          method: "DELETE",
          headers: headers(envApiKey),
        });
      } catch {
        // Cleanup is best-effort; DB state is restored below regardless.
      }
    }

    if (listingId) {
      await prismaClient.pmsListing
        .update({
          where: { id: listingId },
          data: { metadata: originalMetadata },
        })
        .catch(() => undefined);
    }

    if (connectionId) {
      await prismaClient.pmsConnection
        .update({
          where: { id: connectionId },
          data: { webhookSecret: originalWebhookSecret },
        })
        .catch(() => undefined);
    }

    await disconnect().catch(() => undefined);
  }
}

function isDirectExecution() {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;

  try {
    return pathToFileURL(entrypoint).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  void runChannexDemoWebhookCanary().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
