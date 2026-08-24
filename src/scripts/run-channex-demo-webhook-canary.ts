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

const CONFIRM = "RUN_CHANNEX_DEMO_WEBHOOK_CANARY";
const DEMO_NAME = "Pin&Go Demo Property";
const CALLBACK = "https://api.pin-ngo.com/webhooks/channex";

type Deps = {
  prisma?: any;
  fetch?: typeof fetch;
  now?: () => Date;
  generateSecret?: () => string;
  log?: (v: unknown) => void;
  logError?: (v: unknown) => void;
  disconnect?: () => Promise<void>;
};

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown) => String(v ?? "").trim();
const out = (fn: (v: unknown) => void, v: unknown) => fn(JSON.stringify(v));

function errorCode(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[A-Z0-9_:-]{1,200}$/.test(value)
    ? value
    : "CHANNEX_DEMO_WEBHOOK_CANARY_FAILED";
}

function validate(env: NodeJS.ProcessEnv) {
  if (str(env.CHANNEX_DEMO_WEBHOOK_CANARY_CONFIRMATION) !== CONFIRM) {
    throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_CONFIRMATION_REQUIRED");
  }
  const apiKey = str(env.CHANNEX_API_KEY);
  if (!apiKey) throw new Error("CHANNEX_API_KEY_REQUIRED");
  const base = normalizeChannexStagingBaseUrl(
    str(env.CHANNEX_API_BASE_URL || "https://staging.channex.io")
  );
  const callback = normalizeChannexWebhookCallbackUrl(
    str(env.CHANNEX_DEMO_WEBHOOK_CANARY_CALLBACK_URL || CALLBACK)
  );
  if (new URL(callback).hostname !== "api.pin-ngo.com") {
    throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_CALLBACK_MUST_BE_PRODUCTION_API");
  }
  return { apiKey, base, callback };
}

function apiHeaders(apiKey: string) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "user-api-key": apiKey,
  };
}

async function request(fetchImpl: typeof fetch, url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function json(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function cleanup(args: {
  db: any;
  fetchImpl: typeof fetch;
  base: string;
  apiKey: string;
  webhookId: string | null;
  listingId: string | null;
  connectionId: string | null;
  originalMetadata: unknown;
  originalSecret: string | null;
  strict: boolean;
}) {
  const result = {
    remoteWebhookDeleted: args.webhookId == null,
    listingRestored: args.listingId == null,
    connectionRestored: args.connectionId == null,
  };
  const failures: string[] = [];

  if (args.webhookId) {
    try {
      const r = await request(
        args.fetchImpl,
        `${args.base}/api/v1/webhooks/${encodeURIComponent(args.webhookId)}`,
        { method: "DELETE", headers: apiHeaders(args.apiKey) }
      );
      if (!r.ok && r.status !== 404) throw new Error();
      result.remoteWebhookDeleted = true;
    } catch {
      failures.push("REMOTE_WEBHOOK_DELETE");
    }
  }
  if (args.listingId) {
    try {
      await args.db.pmsListing.update({
        where: { id: args.listingId },
        data: { metadata: args.originalMetadata },
      });
      result.listingRestored = true;
    } catch {
      failures.push("LISTING_RESTORE");
    }
  }
  if (args.connectionId) {
    try {
      await args.db.pmsConnection.update({
        where: { id: args.connectionId },
        data: { webhookSecret: args.originalSecret },
      });
      result.connectionRestored = true;
    } catch {
      failures.push("CONNECTION_RESTORE");
    }
  }
  if (args.strict && failures.length) {
    throw new Error(
      `CHANNEX_DEMO_WEBHOOK_CANARY_CLEANUP_FAILED:${failures.join("_")}`
    );
  }
  return result;
}

export async function runChannexDemoWebhookCanary(
  env: NodeJS.ProcessEnv = process.env,
  deps: Deps = {}
) {
  const db = deps.prisma ?? prisma;
  const fetchImpl = deps.fetch ?? fetch;
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const disconnect = deps.disconnect ?? (() => prisma.$disconnect());
  const now = deps.now ?? (() => new Date());
  const generateSecret = deps.generateSecret ?? generateChannexWebhookSecret;

  let base = "";
  let apiKey = "";
  let webhookId: string | null = null;
  let listingId: string | null = null;
  let connectionId: string | null = null;
  let originalMetadata: unknown = null;
  let originalSecret: string | null = null;
  let listingMutated = false;
  let connectionMutated = false;
  let cleaned = false;

  try {
    const cfg = validate(env);
    base = cfg.base;
    apiKey = cfg.apiKey;

    const rows = await db.pmsListing.findMany({
      where: {
        name: DEMO_NAME,
        connection: { is: { provider: "CHANNEX", status: "ACTIVE" } },
      },
      include: { connection: { select: { id: true, webhookSecret: true } } },
      take: 2,
    });
    if (rows.length === 0) {
      throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_LISTING_NOT_FOUND");
    }
    if (rows.length !== 1) {
      throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_LISTING_AMBIGUOUS");
    }

    const listing = rows[0];
    const channexPropertyId = str(rec(listing.metadata).channexPropertyId);
    if (!channexPropertyId) {
      throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_CHANNEX_PROPERTY_ID_MISSING");
    }

    listingId = listing.id;
    connectionId = listing.connection.id;
    originalMetadata = listing.metadata;
    originalSecret = listing.connection.webhookSecret ?? null;
    const before = await db.reservation.count();
    const secret = generateSecret();

    const create = await request(fetchImpl, `${base}/api/v1/webhooks`, {
      method: "POST",
      headers: apiHeaders(apiKey),
      body: JSON.stringify(
        buildChannexBookingWebhookPayload({
          channexPropertyId,
          callbackUrl: cfg.callback,
          webhookSecret: secret,
        })
      ),
    });
    if (!create.ok) {
      throw new Error(`CHANNEX_DEMO_WEBHOOK_CANARY_CREATE_FAILED:${create.status}`);
    }
    const createBody = rec(await json(create));
    webhookId = str(rec(createBody.data).id) || str(createBody.id);
    if (!webhookId) {
      throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_CREATE_RESPONSE_INVALID");
    }

    const verify = await request(
      fetchImpl,
      `${base}/api/v1/webhooks/${encodeURIComponent(webhookId)}`,
      { method: "GET", headers: apiHeaders(apiKey) }
    );
    if (!verify.ok) {
      throw new Error(
        `CHANNEX_DEMO_WEBHOOK_CANARY_VERIFY_FETCH_FAILED:${verify.status}`
      );
    }
    assertVerifiedChannexWebhook({
      responseData: await json(verify),
      webhookId,
      callbackUrl: cfg.callback,
      channexPropertyId,
    });

    await db.pmsConnection.update({
      where: { id: connectionId },
      data: { webhookSecret: secret },
    });
    connectionMutated = true;
    await db.pmsListing.update({
      where: { id: listingId },
      data: {
        metadata: {
          ...rec(originalMetadata),
          channexBookingWebhookId: webhookId,
          channexBookingWebhookEventMask: "booking",
          channexBookingWebhookSendData: false,
          channexBookingWebhookCallbackUrl: cfg.callback,
          channexBookingWebhookVerified: true,
          channexBookingWebhookConfiguredAt: now().toISOString(),
        },
      },
    });
    listingMutated = true;

    if ((await db.reservation.count()) !== before) {
      throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_RESERVATION_DELTA_DETECTED");
    }

    const cleanupResult = await cleanup({
      db,
      fetchImpl,
      base,
      apiKey,
      webhookId,
      listingId,
      connectionId,
      originalMetadata,
      originalSecret,
      strict: true,
    });
    cleaned = true;
    webhookId = listingId = connectionId = null;

    if ((await db.reservation.count()) !== before) {
      throw new Error("CHANNEX_DEMO_WEBHOOK_CANARY_RESERVATION_DELTA_DETECTED");
    }

    out(log, {
      provider: "PIN_GO_CONNECT",
      executionMode: "CHANNEX_DEMO_WEBHOOK_CANARY",
      status: "PASS_REMOTE_WEBHOOK_REGISTRATION",
      property: {
        listingName: DEMO_NAME,
        propertyId: listing.propertyId,
        channexPropertyId,
      },
      callback: {
        host: new URL(cfg.callback).hostname,
        path: new URL(cfg.callback).pathname,
      },
      remoteWebhookCreated: true,
      remoteWebhookVerified: true,
      callbackDeliveryAttempted: false,
      syntheticEventStoredAsPending: false,
      syntheticEventDeleted: false,
      reservationDelta: 0,
      cleanup: cleanupResult,
      workersActivated: false,
      appChannexTouched: false,
    });
    return 0;
  } catch (error) {
    let cleanupResult = null;
    if (!cleaned && base && apiKey) {
      cleanupResult = await cleanup({
        db,
        fetchImpl,
        base,
        apiKey,
        webhookId,
        listingId: listingMutated ? listingId : null,
        connectionId: connectionMutated ? connectionId : null,
        originalMetadata,
        originalSecret,
        strict: false,
      });
    }
    out(logError, {
      provider: "PIN_GO_CONNECT",
      executionMode: "CHANNEX_DEMO_WEBHOOK_CANARY",
      status: "FAILED_SAFE",
      errorCode: errorCode(error),
      cleanup: cleanupResult,
      workersActivated: false,
      appChannexTouched: false,
    });
    return 1;
  } finally {
    await disconnect().catch(() => undefined);
  }
}

function direct() {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]!).href === import.meta.url;
  } catch {
    return false;
  }
}

if (direct()) {
  void runChannexDemoWebhookCanary().then((code) => {
    process.exitCode = code;
  });
}
