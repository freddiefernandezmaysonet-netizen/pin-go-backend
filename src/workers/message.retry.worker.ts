import dotenv from "dotenv";
dotenv.config({ path: "./.env", override: true });

import { PrismaClient } from "@prisma/client";
import { sendSms } from "../integrations/twilio/twilio.client";

const prisma = new PrismaClient();

const WORKER_NAME = "message.retry.worker";
const POLL_MS = Number(process.env.MESSAGE_RETRY_POLL_MS ?? 30000);
const MAX_RETRIES = Number(process.env.MESSAGE_MAX_RETRIES ?? 3);
const BATCH_SIZE = Number(process.env.MESSAGE_RETRY_BATCH_SIZE ?? 20);

function log(...args: any[]) {
  console.log(`[${new Date().toISOString()}] [${WORKER_NAME}]`, ...args);
}

function errLog(...args: any[]) {
  console.error(`[${new Date().toISOString()}] [${WORKER_NAME}]`, ...args);
}

function toErrString(e: unknown) {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

async function processRetries() {
  const failed = await prisma.messageLog.findMany({
    where: {
      status: "FAILED",
      retryCount: { lt: MAX_RETRIES },
    },
    take: BATCH_SIZE,
    orderBy: { createdAt: "asc" },
  });

  if (failed.length === 0) return;

  log("Retry batch", { count: failed.length });

  for (const msg of failed) {
    try {
      log("Retrying message", {
        id: msg.id,
        to: msg.to,
        retryCount: msg.retryCount,
      });

      const sent = await sendSms(msg.to, msg.body);

      await prisma.messageLog.update({
        where: { id: msg.id },
        data: {
          status: "SENT",
          providerMessageId: (sent as any)?.sid ?? null,
          retryCount: { increment: 1 },
          error: null,
        },
      });

      log("Retry success", {
        id: msg.id,
        sid: (sent as any)?.sid ?? null,
      });
    } catch (e) {
      const err = toErrString(e);

      try {
        await prisma.messageLog.update({
          where: { id: msg.id },
          data: {
            retryCount: { increment: 1 },
            error: err,
          },
        });
      } catch (updateErr) {
        errLog("Retry update failed", {
          id: msg.id,
          err: toErrString(updateErr),
        });
      }

      errLog("Retry failed", { id: msg.id, err });
    }
  }
}

let shuttingDown = false;

async function tick() {
  if (shuttingDown) return;

  try {
    await processRetries();
  } catch (e) {
    errLog("processRetries crashed", { err: toErrString(e) });
  }
}

async function start() {
  log(
    `Starting retry worker. poll=${POLL_MS}ms batch=${BATCH_SIZE} maxRetries=${MAX_RETRIES}`
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
    } catch (e) {
      errLog("Error on disconnect", { err: toErrString(e) });
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void start().catch((e) => {
  errLog("Fatal start error", { err: toErrString(e) });
  process.exit(1);
});