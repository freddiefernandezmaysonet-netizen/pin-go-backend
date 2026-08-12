import "dotenv/config";
import { PmsProvider } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { dispatchPmsWebhookEventById } from "../pms/ingest/webhook.dispatcher";
import {
  CHANNEX_RECOVERABLE_EVENT_TYPES,
  processRecoverableWebhookBatch,
} from "../pms/ingest/pms-webhook-recovery.policy";
import { resolvePmsWebhookRecoveryConfig } from "./pms-webhook-recovery.config";

const config = resolvePmsWebhookRecoveryConfig();

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
    now.getTime() - config.staleProcessingMs
  );

  const exhausted = await prisma.webhookEventIngest.updateMany({
    where: {
      provider: PmsProvider.CHANNEX,
      eventType: { in: [...CHANNEX_RECOVERABLE_EVENT_TYPES] },
      attempts: { gte: config.maxAttempts },
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
      maxAttempts: config.maxAttempts,
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
      provider: PmsProvider.CHANNEX,
      eventType: { in: [...CHANNEX_RECOVERABLE_EVENT_TYPES] },
      status: "PROCESSING",
      updatedAt: { lte: args.staleProcessingCutoff },
      attempts: { lt: config.maxAttempts },
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
    const pendingCutoff = new Date(
      now.getTime() - config.pendingMinAgeMs
    );
    const retryCutoff = new Date(now.getTime() - config.retryDelayMs);
    const staleProcessingCutoff = new Date(
      now.getTime() - config.staleProcessingMs
    );

    await markExhaustedEvents(now);

    const events = await prisma.webhookEventIngest.findMany({
      where: {
        provider: PmsProvider.CHANNEX,
        eventType: { in: [...CHANNEX_RECOVERABLE_EVENT_TYPES] },
        attempts: { lt: config.maxAttempts },
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
      take: config.batchSize,
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

    const batchResult = await processRecoverableWebhookBatch({
      events,
      releaseStaleProcessingEvent: async (eventId) =>
        recoverStaleProcessingEvent({
          eventId,
          staleProcessingCutoff,
        }),
      dispatchEvent: dispatchPmsWebhookEventById,
      onEventStart: (event) => {
        log("processing recoverable event", {
          eventId: event.id,
          provider: event.provider,
          eventType: event.eventType,
          previousStatus: event.status,
          attempts: event.attempts,
        });
      },
      onEventError: (event, error) => {
        console.error("[pms.webhook.recovery] event processing failed", {
          eventId: event.id,
          provider: event.provider,
          eventType: event.eventType,
          attempts: event.attempts,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });

    if (events.length > 0) {
      log("batch completed", batchResult);
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
  log("boot", config);

  await tick();
  interval = setInterval(() => void tick(), config.pollMs);
}

process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGINT", () => stop("SIGINT"));

start().catch((error) => {
  logError("boot failed", error);
  void prisma.$disconnect().finally(() => {
    process.exit(1);
  });
});
