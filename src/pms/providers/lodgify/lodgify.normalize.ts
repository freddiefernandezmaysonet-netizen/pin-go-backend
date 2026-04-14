import { PrismaClient } from "@prisma/client";
import { ingestReservation } from "../services/ingest.service";
import {
  normalizeReservation,
} from "../pms/normalizer/reservation.normalizer";

const prisma = new PrismaClient();

const LODGIFY_BASE_URL =
  process.env.LODGIFY_BASE_URL?.trim() || "https://api.lodgify.com";

const LODGIFY_API_KEY = process.env.LODGIFY_API_KEY?.trim() || "";

const LODGIFY_POLL_INTERVAL_MS = Number(
  process.env.LODGIFY_POLL_INTERVAL_MS ?? 120000
);

function log(message: string, meta?: any) {
  console.log("[lodgify.poller]", message, meta ?? "");
}

function errLog(message: string, meta?: any) {
  console.error("[lodgify.poller]", message, meta ?? "");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =====================
// PAYMENT MAPPING
// =====================

function mapPaymentState(
  value: "PAID" | "UNPAID" | "PARTIAL" | "UNKNOWN"
): "NONE" | "PAID" | "FAILED" | "PENDING" {
  if (value === "PAID") return "PAID";
  if (value === "PARTIAL") return "PENDING";
  if (value === "UNPAID") return "PENDING";
  return "NONE";
}

// =====================
// FETCH
// =====================

async function fetchBookings(apiKey: string) {
  const url = new URL("/v2/reservations/bookings", LODGIFY_BASE_URL);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-ApiKey": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `LODGIFY_HTTP_${res.status}: ${res.statusText} ${body.slice(0, 200)}`
    );
  }

  const json = await res.json();

  return Array.isArray(json?.items) ? json.items : [];
}

// =====================
// CORE
// =====================

async function processBooking(connection: any, raw: any) {
  const normalized = await normalizeReservation({
    provider: "LODGIFY",
    eventType: "poll",
    payload: raw,
  });

  if (!normalized.externalListingId) {
    throw new Error(
      `MISSING_EXTERNAL_LISTING_ID:${normalized.externalReservationId}`
    );
  }

  const listing = await prisma.pmsListing.findFirst({
    where: {
      connectionId: connection.id,
      externalListingId: normalized.externalListingId,
    },
    select: {
      propertyId: true,
    },
  });

  if (!listing?.propertyId) {
    throw new Error(
      `LISTING_NEEDS_MAPPING:${normalized.externalListingId}`
    );
  }

  await ingestReservation({
    source: "lodgify",

    propertyId: listing.propertyId,

    guestName: normalized.guestName ?? "Guest",
    guestEmail: normalized.guestEmail,
    guestPhone: normalized.guestPhone,
    roomName: null,

    checkIn: normalized.checkIn,
    checkOut: normalized.checkOut,

    paymentState: mapPaymentState(normalized.paymentState),

    externalProvider: "lodgify",
    externalId: normalized.externalReservationId,
    externalUpdatedAt: normalized.rawUpdatedAt ?? undefined,
    externalRaw: raw,
    status: normalized.status,
  });
}

// =====================
// CONNECTION
// =====================

async function processConnection(connection: any) {
  const stats = {
    fetched: 0,
    ingested: 0,
    mappingMissing: 0,
    errors: 0,
  };

  log("connection sync started", {
    connectionId: connection.id,
  });

  const bookings = await fetchBookings(LODGIFY_API_KEY);

  stats.fetched = bookings.length;

  for (const b of bookings) {
    try {
      await processBooking(connection, b);
      stats.ingested++;
    } catch (e: any) {
      const msg = String(e?.message ?? e);

      if (msg.startsWith("LISTING_NEEDS_MAPPING")) {
        stats.mappingMissing++;
        log("listing needs mapping", {
          connectionId: connection.id,
          error: msg,
        });
        continue;
      }

      stats.errors++;
      errLog("booking error", { msg });
    }
  }

  log("connection sync finished", {
    connectionId: connection.id,
    ...stats,
  });
}

// =====================
// WORKER
// =====================

let running = false;

async function tick() {
  if (running) {
    log("skip overlapping tick");
    return;
  }

  running = true;

  try {
    const connections = await prisma.pmsConnection.findMany({
      where: {
        provider: "LODGIFY",
      },
    });

    log("tick started", {
      connections: connections.length,
      intervalMs: LODGIFY_POLL_INTERVAL_MS,
    });

    for (const conn of connections) {
      try {
        await processConnection(conn);
      } catch (e: any) {
        errLog("connection error", {
          connectionId: conn.id,
          msg: String(e?.message ?? e),
        });
      }

      await sleep(200);
    }

    log("tick finished");
  } catch (e: any) {
    errLog("tick error", {
      msg: String(e?.message ?? e),
    });
  } finally {
    running = false;
  }
}

// =====================
// BOOT
// =====================

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