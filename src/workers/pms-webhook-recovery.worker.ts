import "dotenv/config";
import { prisma } from "../lib/prisma";
import { dispatchPmsWebhookEventById } from "../pms/ingest/webhook.dispatcher";

const POLL_MS = Number(
  process.env.PMS_WEBHOOK_RECOVERY_POLL_MS ?? 60_000
);
const BATCH_SIZE = Number(
  process.env.PMS_WEBHOOK_RECOVERY_BATCH_SIZE ?? 20
);
const MAX_ATTEMPTS = Number(
  process.env.PMS_WEBHOOK_RECOVERY_MAX_ATTEMPTS ?? 8
);
const PENDING_MIN_AGE_MS = Number(
  process.env.PMS_WEBHOOK_RECOVERY_PENDING_MIN_AGE_MS ?? 30_000
);
const RETRY_DELAY_MS = Number(
  process.env.PMS_WEBHOOK_RECOVERY_RETRY_DELAY_MS ?? 60_000
);
const STALE_PROCESSING_MS = Number(
  process.env.PMS_WEBHOOK_RECOVERY_STALE_PROCESSING_MS ?? 10 * 60_000
);

let interval: NodeJS.Timeout | null = null;
let tickRunning = false;

function log(message: string, metadata?: Record<string, unknown>) {
  console.log("[pms.webhook.recovery]", message, metadata ?? {});
}

function logError(message: string, error: unknown) {
  console.error("[pms.webhook.recovery]", message, {
    error: error instanceof Error ? error.message : String(error),
  });
}

async function markExhaustedEvents(now: Date) {
  const staleProcessingCutoff = new Date(
    now.getTime() - STALE_PROCESSING_MS
  );

  const exhausted = await prisma.webhookEventIngest.updateMany({
    where: {
      attempts: { gte: MAX_ATTEMPTS },
      OR: [
        { status: "FAILED" },
        {
          status: "PROCESSING",
          updatedAt: { lte: staleProcessingCutoff },
        },
      ],
    },
    data: {
      status: "DEAD",
    },
  });

  if (exhausted.count > 0) {
    log("marked exhausted events dead", {
      count: exhausted.count,
      maxAttempts: MAX_ATTEMPTS,
    });
  }
}

async function recoverStaleProcessingEvent(args: {
  eventId: string;
  staleProcessingCutoff: Date;
}) {
  const released = await prisma.webhookEventIngest.updateMany({
    where: {
      id: args.eventId,
      status: "PROCESSING",
      updatedAt: { lte: args.staleProcessingCutoff },
      attempts: { lt: MAX_ATTEMPTS },
    },
    data: {
      status: "FAILED",
      lastError: "RECOVERED_STALE_PROCESSING_LEASE",
    },
  });

  return released.count === 1;
}

async function tick() {
  if (tickRunning) {
    log("tick skipped because previous tick is still running");
    return;
  }

  tickRunning = true;

  try {
    const now = new Date();
    const pendingCutoff = new Date(now.getTime() - PENDING_MIN_AGE_MS);
    const retryCutoff = new Date(now.getTime() - RETRY_DELAY_MS);
    const staleProcessingCutoff = new Date(
      now.getTime() - STALE_PROCESSING_MS
    );

    await markExhaustedEvents(now);

    const events = await prisma.webhookEventIngest.findMany({
      where: {
        attempts: { lt: MAX_ATTEMPTS },
        OR: [
          {
            status: "PENDING",
            receivedAt: { lte: pendingCutoff },
          },
          {
            status: "FAILED",
            updatedAt: { lte: retryCutoff },
          },
          {
            status: "PROCESSING",
            updatedAt: { lte: staleProcessingCutoff },
          },
        ],
      },
      orderBy: [
        { receivedAt: "asc" },
        { createdAt: "asc" },
      ],
      take: BATCH_SIZE,
      select: {
        id: true,
        provider: true,
        eventType: true,
        status: true,
        attempts: true,
      },
    });

    if (events.length > 0) {
      log("recoverable events found", {
        count: events.length,
      });
    }

    for (const event of events) {
      if (event.status === "PROCESSING") {
        const released = await recoverStaleProcessingEvent({
          eventId: event.id,
          staleProcessingCutoff,
        });

        if (!released) {
          continue;
        }
      }

      log("processing recoverable event", {
        eventId: event.id,
        provider: event.provider,
        eventType: event.eventType,
        previousStatus: event.status,
        attempts: event.attempts,
      });

      try {
        await dispatchPmsWebhookEventById(event.id);
      } catch (error) {
        console.error("[pms.webhook.recovery] event processing failed", {
          eventId: event.id,
          provider: event.provider,
          eventType: event.eventType,
          attempts: event.attempts,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    logError("tick failed", error);
  } finally {
    tickRunning = false;
  }
}

function stop(signal: string) {
  log("shutdown requested", { signal });

  if (interval) {
    clearInterval(interval);
    interval = null;
  }

  void prisma.$disconnect().finally(() => {
    process.exit(0);
  });
}

async function start() {
  log("boot", {
    pollMs: POLL_MS,
    batchSize: BATCH_SIZE,
    maxAttempts: MAX_ATTEMPTS,
    pendingMinAgeMs: PENDING_MIN_AGE_MS,
    retryDelayMs: RETRY_DELAY_MS,
    staleProcessingMs: STALE_PROCESSING_MS,
  });

  await tick();
  interval = setInterval(() => void tick(), POLL_MS);
}

process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGINT", () => stop("SIGINT"));

start().catch((error) => {
  logError("boot failed", error);
  void prisma.$disconnect().finally(() => {
    process.exit(1);
  });
});
