import dotenv from "dotenv";
dotenv.config({ path: "./.env", override: true });

import { prisma } from "../lib/prisma";
import { sendSms } from "../integrations/twilio/twilio.client";

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

function isNonRetryableSmsError(value: unknown) {
  const error = String(value ?? "").toLowerCase();

  return (
    error.includes("not a valid phone number") ||
    error.includes("invalid phone number") ||
    error.includes("invalid 'to' phone number") ||
    error.includes("unable to create record") ||
    error.includes("the 'to' number") ||
    error.includes("is not a valid") ||
    error.includes("not sms capable") ||
    error.includes("not a mobile number") ||
    error.includes("landline") ||
    error.includes("unsubscribed") ||
    error.includes("blacklisted") ||
    error.includes("recipient is unable to receive") ||
    error.includes("destination phone number") ||
    error.includes("twilio error 21211") ||
    error.includes("twilio error 21614") ||
    error.includes("21211") ||
    error.includes("21614")
  );
}

async function processRetries() {
  const failedSmsMessages = await prisma.messageLog.findMany({
    where: {
      channel: "sms",
      status: "FAILED",
      retryCount: { lt: MAX_RETRIES },
    },
    take: BATCH_SIZE,
    orderBy: { createdAt: "asc" },
  });

  if (failedSmsMessages.length === 0) return;

  log("Retry batch", {
    channel: "sms",
    count: failedSmsMessages.length,
  });

  for (const msg of failedSmsMessages) {
    try {
      log("Retrying SMS message", {
        id: msg.id,
        to: msg.to,
        channel: msg.channel,
        retryCount: msg.retryCount,
      });

      if (isNonRetryableSmsError(msg.error)) {
        await prisma.messageLog.update({
          where: { id: msg.id },
          data: {
            status: "FAILED_FINAL",
            error: msg.error ?? "Non-retryable SMS delivery error",
          },
        });

        errLog("SMS retry stopped: non-retryable error", {
          id: msg.id,
          to: msg.to,
          retryCount: msg.retryCount,
          error: msg.error,
        });

        continue;
      }

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

      log("SMS retry success", {
        id: msg.id,
        sid: (sent as any)?.sid ?? null,
      });
    } catch (e) {
      const err = toErrString(e);
      const nonRetryable = isNonRetryableSmsError(err);

      try {
        await prisma.messageLog.update({
          where: { id: msg.id },
          data: {
            status: nonRetryable ? "FAILED_FINAL" : "FAILED",
            retryCount: { increment: 1 },
            error: err,
          },
        });
      } catch (updateErr) {
        errLog("SMS retry update failed", {
          id: msg.id,
          err: toErrString(updateErr),
        });
      }

      if (nonRetryable) {
        errLog("SMS retry stopped after non-retryable Twilio error", {
          id: msg.id,
          to: msg.to,
          err,
        });
      } else {
        errLog("SMS retry failed", {
          id: msg.id,
          err,
        });
      }
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