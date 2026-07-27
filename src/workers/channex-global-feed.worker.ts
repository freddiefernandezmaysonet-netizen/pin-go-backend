import "dotenv/config";
import { pathToFileURL } from "node:url";
import { prisma } from "../lib/prisma";
import { runChannexGlobalFeedOnce } from "../pms/ingest/channex-global-feed.service";
import {
  resolveChannexGlobalFeedConfig,
  type ChannexGlobalFeedConfig,
} from "./channex-global-feed.config";

export type ChannexGlobalFeedWorkerLogger = {
  info: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, metadata?: Record<string, unknown>) => void;
};

export type ChannexGlobalFeedWorkerController = {
  start: () => Promise<void>;
  stop: (signal?: string) => Promise<void>;
  tick: () => Promise<void>;
  isRunning: () => boolean;
  isStopping: () => boolean;
};

function defaultLogger(): ChannexGlobalFeedWorkerLogger {
  return {
    info(message, metadata) {
      console.log("[channex.global-feed]", message, metadata ?? {});
    },
    error(message, metadata) {
      console.error("[channex.global-feed]", message, metadata ?? {});
    },
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createChannexGlobalFeedWorker(args: {
  config: ChannexGlobalFeedConfig;
  runOnce?: typeof runChannexGlobalFeedOnce;
  disconnect?: () => Promise<void>;
  logger?: ChannexGlobalFeedWorkerLogger;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}): ChannexGlobalFeedWorkerController {
  const runOnce = args.runOnce ?? runChannexGlobalFeedOnce;
  const disconnect = args.disconnect ?? (() => prisma.$disconnect());
  const logger = args.logger ?? defaultLogger();
  const setIntervalFn = args.setIntervalFn ?? setInterval;
  const clearIntervalFn = args.clearIntervalFn ?? clearInterval;

  let interval: NodeJS.Timeout | null = null;
  let currentTick: Promise<void> | null = null;
  let started = false;
  let stopping = false;
  let disconnected = false;

  const disconnectOnce = async () => {
    if (disconnected) return;
    disconnected = true;
    await disconnect();
  };

  const tick = async () => {
    if (stopping) {
      logger.info("tick skipped because shutdown is in progress");
      return;
    }

    if (currentTick) {
      logger.info("tick skipped because previous tick is still running");
      return;
    }

    currentTick = (async () => {
      try {
        const result = await runOnce({ config: args.config });

        logger.info("tick completed", {
          status: result.status,
          connectionCount: result.connectionCount,
          credentialSourceCount: result.credentialSourceCount,
          discoveredRevisionCount: result.discoveredRevisionCount,
          selectedRevisionCount: result.selectedRevisionCount,
          truncatedRevisionCount: result.truncatedRevisionCount,
          acknowledgedRevisionCount: result.acknowledgedRevisionCount,
          failedRevisionCount: result.failedRevisionCount,
          failedSourceCount: result.failedSourceCount,
          emptyFeed: result.emptyFeed,
        });
      } catch (error) {
        logger.error("tick failed", {
          error: errorMessage(error),
        });
      } finally {
        currentTick = null;
      }
    })();

    await currentTick;
  };

  const start = async () => {
    if (started) {
      logger.info("start skipped because worker is already running");
      return;
    }

    if (stopping) {
      throw new Error("CHANNEX_GLOBAL_FEED_WORKER_STOPPING");
    }

    started = true;
    logger.info("boot", args.config);

    await tick();

    if (!stopping) {
      interval = setIntervalFn(() => {
        void tick();
      }, args.config.pollMs);
    }
  };

  const stop = async (signal = "MANUAL") => {
    if (stopping) {
      if (currentTick) await currentTick;
      await disconnectOnce();
      return;
    }

    stopping = true;
    logger.info("shutdown requested", { signal });

    if (interval) {
      clearIntervalFn(interval);
      interval = null;
    }

    if (currentTick) {
      await currentTick;
    }

    await disconnectOnce();
    logger.info("shutdown completed", { signal });
  };

  return {
    start,
    stop,
    tick,
    isRunning: () => currentTick !== null,
    isStopping: () => stopping,
  };
}

function isDirectExecution() {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;

  try {
    return pathToFileURL(entrypoint).href === import.meta.url;
  } catch {
    return false;
  }
}

async function runWorkerProcess() {
  const logger = defaultLogger();
  const config = resolveChannexGlobalFeedConfig();
  const worker = createChannexGlobalFeedWorker({ config, logger });
  let exitStarted = false;

  const shutdown = (signal: string, exitCode: number) => {
    if (exitStarted) return;
    exitStarted = true;

    void worker
      .stop(signal)
      .then(() => process.exit(exitCode))
      .catch((error) => {
        logger.error("shutdown failed", {
          signal,
          error: errorMessage(error),
        });
        process.exit(1);
      });
  };

  process.once("SIGTERM", () => shutdown("SIGTERM", 0));
  process.once("SIGINT", () => shutdown("SIGINT", 0));

  try {
    await worker.start();
  } catch (error) {
    logger.error("boot failed", {
      error: errorMessage(error),
    });
    shutdown("BOOT_FAILURE", 1);
  }
}

if (isDirectExecution()) {
  void runWorkerProcess();
}
