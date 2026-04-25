import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { processWebhookEventById } from "../pms/ingest/webhook.processor";

type LodgifyBooking = {
  id?: number | string;
  property_id?: number | string | null;
  updated_at?: string | null;
  created_at?: string | null;
  property?: Record<string, unknown> | null;
  property_name?: string | null;
  arrival?: string | null;
  departure?: string | null;
  [key: string]: unknown;
};

type LodgifyConnection = {
  id: string;
  provider: string;
  status?: string | null;
  createdAt?: Date;
  credentialsEncrypted?: string | null;
};

type LodgifyProperty = {
  id?: number | string | null;
  name?: string | null;
  [key: string]: unknown;
};

const prisma = new PrismaClient();

const LODGIFY_BASE_URL =
  process.env.LODGIFY_BASE_URL?.trim() || "https://api.lodgify.com";

const LODGIFY_POLL_INTERVAL_MS = Number(
  process.env.LODGIFY_POLL_INTERVAL_MS ?? 120_000
);

const PAGE_SIZE = Number(process.env.LODGIFY_POLL_PAGE_SIZE ?? 100);
const MAX_PAGES = Number(process.env.LODGIFY_POLL_MAX_PAGES ?? 200);

const PROPERTY_CACHE_TTL_MS = Number(
  process.env.LODGIFY_PROPERTY_CACHE_TTL_MS ?? 10 * 60 * 1000
);

const propertyCache = new Map<
  string,
  {
    value: LodgifyProperty | null;
    expiresAt: number;
  }
>();

function log(message: string, meta?: Record<string, unknown>) {
  console.log("[lodgify.poller]", message, meta ?? "");
}

function errLog(message: string, meta?: Record<string, unknown>) {
  console.error("[lodgify.poller]", message, meta ?? "");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getEncryptionKey() {
  const secret = process.env.PMS_CREDENTIALS_SECRET ?? "";
  if (!secret) {
    throw new Error("PMS_CREDENTIALS_SECRET not configured");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

function decryptJson(payload: string) {
  const parsed = JSON.parse(payload ?? "{}");

  if (
    !parsed ||
    parsed.alg !== "aes-256-gcm" ||
    !parsed.iv ||
    !parsed.tag ||
    !parsed.data
  ) {
    throw new Error("INVALID_ENCRYPTED_PMS_CREDENTIALS");
  }

  const key = getEncryptionKey();
  const iv = Buffer.from(parsed.iv, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  const data = Buffer.from(parsed.data, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]).toString("utf8");

  return JSON.parse(decrypted);
}

function getConnectionApiKey(connection: LodgifyConnection): string {
  const encrypted = String(connection.credentialsEncrypted ?? "").trim();
  if (!encrypted) return "";

  try {
    const creds = decryptJson(encrypted);
    const apiKey = String(
      creds?.apiKey ??
        creds?.api_key ??
        creds?.lodgifyApiKey ??
        creds?.xApiKey ??
        ""
    ).trim();

    return apiKey;
  } catch (e: any) {
    errLog("credentials decrypt failed", {
      connectionId: connection.id,
      error: String(e?.message ?? e),
    });
    return "";
  }
}

async function fetchBookingsPage(params: {
  apiKey: string;
  page: number;
  pageSize: number;
}) {
  const url = new URL("/v2/reservations/bookings", LODGIFY_BASE_URL);

  url.searchParams.set("page", String(params.page));
  url.searchParams.set("pageSize", String(params.pageSize));

  const res = await fetch(url.toString(), {
    headers: {
      "X-ApiKey": params.apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LODGIFY_HTTP_${res.status}: ${body}`);
  }

  const json = await res.json();

  return {
    items: Array.isArray(json?.items) ? json.items : [],
    count: json?.count ?? 0,
  };
}

async function fetchAllBookings(apiKey: string) {
  const all: LodgifyBooking[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { items } = await fetchBookingsPage({
      apiKey,
      page,
      pageSize: PAGE_SIZE,
    });

    if (!items.length) break;

    for (const b of items) {
      const id = String(b?.id ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      all.push(b);
    }

    if (items.length < PAGE_SIZE) break;
  }

  return all;
}

function cacheKey(connectionId: string, propertyId: string | number) {
  return `${connectionId}:${propertyId}`;
}

async function fetchProperty(
  apiKey: string,
  connectionId: string,
  propertyId: string | number
): Promise<LodgifyProperty | null> {
  const key = cacheKey(connectionId, propertyId);
  const cached = propertyCache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const url = new URL(`/v2/properties/${propertyId}`, LODGIFY_BASE_URL);

    const res = await fetch(url.toString(), {
      headers: {
        "X-ApiKey": apiKey,
        Accept: "application/json",
      },
    });

    if (!res.ok) throw new Error(`HTTP_${res.status}`);

    const json = await res.json();

    propertyCache.set(key, {
      value: json,
      expiresAt: Date.now() + PROPERTY_CACHE_TTL_MS,
    });

    return json;
  } catch (e: any) {
    errLog("property fetch failed", {
      propertyId,
      error: String(e?.message ?? e),
    });

    propertyCache.set(key, {
      value: null,
      expiresAt: Date.now() + PROPERTY_CACHE_TTL_MS,
    });

    return null;
  }
}

async function enrichBooking(
  connection: LodgifyConnection,
  booking: LodgifyBooking,
  apiKey: string
): Promise<LodgifyBooking> {
  const propertyId = booking?.property_id;

  if (!propertyId) return booking;

  const property = await fetchProperty(apiKey, connection.id, propertyId);

  return {
    ...booking,
    property: property ?? booking.property ?? null,
    property_name:
      property?.name ??
      booking.property_name ??
      (booking.property as any)?.name ??
      null,
  };
}

function parseUpdatedAt(value: unknown): number | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

async function createAndProcessEvent(params: {
  connection: LodgifyConnection;
  booking: LodgifyBooking;
}) {
  const { connection, booking } = params;

  const bookingId = String(booking?.id ?? "").trim();
  if (!bookingId) throw new Error("MISSING_BOOKING_ID");

  const apiKey = getConnectionApiKey(connection);
  if (!apiKey) throw new Error("MISSING_API_KEY");

  const enriched = await enrichBooking(connection, booking, apiKey);

  const externalEventId = `lodgify:${connection.id}:${bookingId}`;

  let ev = await prisma.webhookEventIngest.findFirst({
    where: {
      connectionId: connection.id,
      provider: "LODGIFY",
      externalEventId,
    },
    orderBy: { createdAt: "desc" },
  });

  const incomingUpdatedAtMs = parseUpdatedAt(enriched?.updated_at);
  const existingUpdatedAtMs = parseUpdatedAt(
    (ev?.payloadRaw as any)?.updated_at
  );

  log("event compare", {
    bookingId,
    incomingUpdatedAt: enriched?.updated_at ?? null,
    existingUpdatedAt: (ev?.payloadRaw as any)?.updated_at ?? null,
  });

  if (
    ev &&
    incomingUpdatedAtMs !== null &&
    existingUpdatedAtMs !== null &&
    incomingUpdatedAtMs <= existingUpdatedAtMs
  ) {
    log("skip older/equal snapshot", {
      bookingId,
      incomingUpdatedAt: enriched?.updated_at ?? null,
      existingUpdatedAt: (ev?.payloadRaw as any)?.updated_at ?? null,
    });
    return;
  }

  if (!ev) {
    ev = await prisma.webhookEventIngest.create({
      data: {
        provider: "LODGIFY",
        connectionId: connection.id,
        eventType: "booking_poll",
        externalEventId,
        payloadRaw: enriched as any,
        status: "PENDING",
      } as any,
    });
  } else {
    ev = await prisma.webhookEventIngest.update({
      where: { id: ev.id },
      data: {
        payloadRaw: enriched as any,
        status: "PENDING",
        lastError: null,
      } as any,
    });
  }

  await processWebhookEventById(ev.id);
}

async function processConnection(connection: LodgifyConnection) {
  const apiKey = getConnectionApiKey(connection);
  if (!apiKey) throw new Error("MISSING_API_KEY");

  const bookings = await fetchAllBookings(apiKey);

  for (const b of bookings) {
    log("booking snapshot", {
      connectionId: connection.id,
      bookingId: b?.id ?? null,
      arrival: b?.arrival ?? null,
      departure: b?.departure ?? null,
      updated_at: b?.updated_at ?? null,
      property_id: b?.property_id ?? null,
    });


   try {
      await createAndProcessEvent({ connection, booking: b });
    } catch (e: any) {
      errLog("booking failed", {
        bookingId: b?.id,
        error: String(e?.message ?? e),
      });
    }
  }
// 🔥 FIX: targeted refresh for ACTIVE reservations already in Pin&Go
const activeReservations = await prisma.reservation.findMany({
  where: {
    externalProvider: "LODGIFY",
    status: "ACTIVE",
  },
  select: {
    externalId: true,
  },
  take: 50, // límite seguro
});

for (const r of activeReservations) {
  const bookingId = String(r.externalId ?? "").trim();
  if (!bookingId) continue;

  try {
    const url = new URL(
      `/v2/reservations/bookings/${bookingId}`,
      LODGIFY_BASE_URL
    );

    const res = await fetch(url.toString(), {
      headers: {
        "X-ApiKey": apiKey,
        Accept: "application/json",
      },
    });

    if (!res.ok) continue;

    const booking = await res.json();

    log("targeted booking refresh", {
      connectionId: connection.id,
      bookingId,
    });

    await createAndProcessEvent({
      connection,
      booking,
    });
  } catch (e: any) {
    errLog("targeted refresh failed", {
      bookingId,
      error: String(e?.message ?? e),
    });
  }
}

let running = false;

async function tick() {
  if (running) return;
  running = true;

  try {
    const connections = await prisma.pmsConnection.findMany({
      where: { provider: "LODGIFY", status: "ACTIVE" },
      select: {
        id: true,
        provider: true,
        status: true,
        createdAt: true,
        credentialsEncrypted: true,
      },
    });

    for (const conn of connections) {
      await processConnection(conn);
      await sleep(200);
    }
  } catch (e: any) {
    errLog("tick error", { error: String(e?.message ?? e) });
  } finally {
    running = false;
  }
}

export async function startLodgifyPoller() {
  log("BOOT", {
    interval: LODGIFY_POLL_INTERVAL_MS,
  });

  await tick();

  setInterval(() => {
    void tick();
  }, LODGIFY_POLL_INTERVAL_MS);
}

void startLodgifyPoller();