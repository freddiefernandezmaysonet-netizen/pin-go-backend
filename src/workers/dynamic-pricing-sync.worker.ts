import dotenv from "dotenv";
dotenv.config({ path: "./.env", override: true });

import { prisma } from "../lib/prisma";
import { syncChannexAvailabilityForProperty } from "../services/channex-availability-sync.service";

const WORKER_NAME = "dynamic-pricing-sync.worker";

const POLL_MS = Number(
  process.env.DYNAMIC_PRICING_SYNC_WORKER_POLL_MS ?? 6 * 60 * 60 * 1000
);

const BATCH_SIZE = Number(
  process.env.DYNAMIC_PRICING_SYNC_BATCH_SIZE ?? 10
);

const WINDOW_DAYS = Number(
  process.env.DYNAMIC_PRICING_SYNC_WINDOW_DAYS ?? 365
);

let running = false;
let shuttingDown = false;

function log(...args: any[]) {
  console.log(`[${WORKER_NAME}]`, ...args);
}

function errLog(...args: any[]) {
  console.error(`[${WORKER_NAME}]`, ...args);
}

function toErrString(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function tick() {
  if (running) {
    log("Previous tick still running. Skipping.");
    return;
  }

  running = true;

  try {
   const properties = await prisma.property.findMany({
  where: {
    distributionEnabled: true,
  },
  select: {
    id: true,
    name: true,
  },
  take: BATCH_SIZE,
  orderBy: {
    updatedAt: "asc",
  },
});
    log(
      `Found ${properties.length} active distributed propert${
        properties.length === 1 ? "y" : "ies"
      } to sync.`
    );

    for (const property of properties) {
      try {
        log(`Syncing ${property.name ?? property.id}...`);

        const result = await syncChannexAvailabilityForProperty(
  property.id,
  WINDOW_DAYS
);

if (result?.skipped) {
  log(
    `Skipped ${property.name ?? property.id}: ${
      result.reason ?? "UNKNOWN_REASON"
    }`
  );
  continue;
}

log(`Synced ${property.name ?? property.id}.`);
      } catch (error) {
        errLog(
          `Failed to sync ${property.name ?? property.id}:`,
          toErrString(error)
        );

        await prisma.property.update({
          where: {
            id: property.id,
          },
          data: {
            distributionLastError: toErrString(error),
          },
        });
      }
    }
  } catch (error) {
    errLog("Tick failed:", toErrString(error));
  } finally {
    running = false;
  }
}

async function start() {
  log(
    `Starting. poll=${POLL_MS}ms batch=${BATCH_SIZE} window=${WINDOW_DAYS}d`
  );

  log(
    "ENV DATABASE_URL =",
    process.env.DATABASE_URL ? process.env.DATABASE_URL : "❌ UNDEFINED"
  );

  await tick();

  const interval = setInterval(() => void tick(), POLL_MS);

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    log(`Received ${signal}. Shutting down...`);
    clearInterval(interval);

    try {
      await prisma.$disconnect();
      log("Disconnected Prisma. Bye.");
    } catch (error) {
      errLog("Error on disconnect:", toErrString(error));
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void start().catch((error) => {
  errLog("Fatal start error:", toErrString(error));
  process.exit(1);
});