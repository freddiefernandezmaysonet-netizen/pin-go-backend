import "dotenv/config";
import { pathToFileURL } from "node:url";

import { prisma } from "../lib/prisma";
import type { ChannexAriDispatchCycleDb } from "../pms/outbound/channex-ari-dispatch-cycle.service";
import {
  resolveChannexAriDispatchActivation,
  type ChannexAriDispatchActivation,
} from "./channex-ari-dispatch.activation";
import {
  resolveChannexAriDispatchConfig,
  type ChannexAriDispatchConfig,
} from "./channex-ari-dispatch.config";
import {
  createChannexAriDispatchWorker,
  type ChannexAriDispatchWorkerController,
  type ChannexAriDispatchWorkerLogger,
} from "./channex-ari-dispatch.worker";

export const CHANNEX_ARI_DISPATCH_DISABLED_KEEPALIVE_MS =
  24 * 60 * 60_000;

export type ChannexAriDispatchProcessRuntime = {
  activation: ChannexAriDispatchActivation;
  config: ChannexAriDispatchConfig;
  worker: ChannexAriDispatchWorkerController;
  stop: (signal?: string) => Promise<void>;
};

export type StartChannexAriDispatchProcessInput = {
  db: ChannexAriDispatchCycleDb;
  disconnect: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
  logger?: ChannexAriDispatchWorkerLogger;
  createWorker?: typeof createChannexAriDispatchWorker;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
};

function defaultLogger(): ChannexAriDispatchWorkerLogger {
  return {
    info(message, metadata) {
      console.log("[channex.ari-dispatch.process]", message, metadata ?? {});
    },
    error(message, metadata) {
      console.error("[channex.ari-dispatch.process]", message, metadata ?? {});
    },
  };
}

function publicErrorCode(error: unknown): string {
  const message =
    error instanceof Error ? String(error.message ?? "").trim() : "";

  return /^[A-Z0-9_]+$/.test(message) && message.length <= 128
    ? message
    : "CHANNEX_ARI_DISPATCH_PROCESS_FAILED";
}

export function isChannexAriDispatchProcessEntrypoint(
  entrypoint = process.argv[1],
  moduleUrl = import.meta.url
): boolean {
  if (!entrypoint) return false;

  try {
    return pathToFileURL(entrypoint).href === moduleUrl;
  } catch {
    return false;
  }
}

export async function startChannexAriDispatchProcess(
  input: StartChannexAriDispatchProcessInput
): Promise<ChannexAriDispatchProcessRuntime> {
  const env = input.env ?? process.env;
  const logger = input.logger ?? defaultLogger();
  const createWorker = input.createWorker ?? createChannexAriDispatchWorker;
  const setIntervalFn = input.setIntervalFn ?? setInterval;
  const clearIntervalFn = input.clearIntervalFn ?? clearInterval;
  const activation = resolveChannexAriDispatchActivation(env);
  const config = resolveChannexAriDispatchConfig(env);
  let idleKeepAlive: NodeJS.Timeout | null = null;
  let stopped = false;

  const worker = createWorker({
    db: input.db,
    disconnect: input.disconnect,
    activation,
    config,
    credentialsSecret: env.PMS_CREDENTIALS_SECRET,
    globalApiKey: env.CHANNEX_API_KEY,
    baseUrl: env.CHANNEX_API_BASE_URL,
    logger,
    setIntervalFn,
    clearIntervalFn,
  });

  await worker.start();

  if (!activation.enabled) {
    idleKeepAlive = setIntervalFn(
      () => undefined,
      CHANNEX_ARI_DISPATCH_DISABLED_KEEPALIVE_MS
    );
  }

  const stop = async (signal = "MANUAL") => {
    if (stopped) return;
    stopped = true;

    if (idleKeepAlive) {
      clearIntervalFn(idleKeepAlive);
      idleKeepAlive = null;
    }

    await worker.stop(signal);
  };

  return {
    activation,
    config,
    worker,
    stop,
  };
}

async function runDirectProcess() {
  const logger = defaultLogger();
  let runtime: ChannexAriDispatchProcessRuntime | null = null;
  let exitStarted = false;

  const shutdown = (signal: string, exitCode: number) => {
    if (exitStarted) return;
    exitStarted = true;

    const stopPromise = runtime
      ? runtime.stop(signal)
      : prisma.$disconnect();

    void stopPromise
      .then(() => process.exit(exitCode))
      .catch((error) => {
        logger.error("shutdown failed", {
          signal,
          errorCode: publicErrorCode(error),
        });
        process.exit(1);
      });
  };

  process.once("SIGTERM", () => shutdown("SIGTERM", 0));
  process.once("SIGINT", () => shutdown("SIGINT", 0));

  try {
    runtime = await startChannexAriDispatchProcess({
      db: prisma,
      disconnect: () => prisma.$disconnect(),
      logger,
    });
  } catch (error) {
    logger.error("boot failed", {
      errorCode: publicErrorCode(error),
    });
    shutdown("BOOT_FAILURE", 1);
  }
}

if (isChannexAriDispatchProcessEntrypoint()) {
  void runDirectProcess();
}
