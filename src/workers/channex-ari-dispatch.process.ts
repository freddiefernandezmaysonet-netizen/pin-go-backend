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
export const CHANNEX_ARI_PRODUCTION_ORIGIN = "https://app.channex.io";

export type ChannexAriDispatchProviderConfig = {
  apiKey: string;
  baseUrl: string;
};

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

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveChannexAriDispatchProviderConfig(
  env: NodeJS.ProcessEnv = process.env
): ChannexAriDispatchProviderConfig {
  const apiKey = normalizedText(env.OTA_CONNECTION_API_KEY);
  if (!apiKey || apiKey.length > 4_096) {
    throw new Error("CHANNEX_ARI_OTA_API_KEY_REQUIRED");
  }

  const configuredOrigin = normalizedText(
    env.OTA_CONNECTION_PROVIDER_API_ORIGIN
  );
  let parsed: URL;

  try {
    parsed = new URL(configuredOrigin);
  } catch {
    throw new Error("CHANNEX_ARI_OTA_ORIGIN_INVALID");
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.pathname !== "/" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("CHANNEX_ARI_OTA_ORIGIN_INVALID");
  }

  if (
    normalizedText(env.NODE_ENV).toLowerCase() === "production" &&
    parsed.origin !== CHANNEX_ARI_PRODUCTION_ORIGIN
  ) {
    throw new Error("CHANNEX_ARI_PRODUCTION_ORIGIN_REQUIRED");
  }

  return {
    apiKey,
    baseUrl: parsed.origin,
  };
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
  const provider = activation.enabled
    ? resolveChannexAriDispatchProviderConfig(env)
    : null;
  let idleKeepAlive: NodeJS.Timeout | null = null;
  let stopped = false;

  const worker = createWorker({
    db: input.db,
    disconnect: input.disconnect,
    activation,
    config,
    credentialsSecret: env.PMS_CREDENTIALS_SECRET,
    globalApiKey: provider?.apiKey,
    baseUrl: provider?.baseUrl,
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
