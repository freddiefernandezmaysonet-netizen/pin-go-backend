import {
  runChannexAriDispatchCycle,
  type ChannexAriDispatchCycleDb,
} from "../pms/outbound/channex-ari-dispatch-cycle.service";
import type { ChannexAriDispatchActivation } from "./channex-ari-dispatch.activation";
import type { ChannexAriDispatchConfig } from "./channex-ari-dispatch.config";

export type ChannexAriDispatchWorkerLogger = {
  info: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, metadata?: Record<string, unknown>) => void;
};

export type ChannexAriDispatchWorkerController = {
  start: () => Promise<void>;
  stop: (signal?: string) => Promise<void>;
  tick: () => Promise<void>;
  isRunning: () => boolean;
  isStopping: () => boolean;
};

export type CreateChannexAriDispatchWorkerInput = {
  db: ChannexAriDispatchCycleDb;
  config: ChannexAriDispatchConfig;
  activation: ChannexAriDispatchActivation;
  credentialsSecret?: string;
  globalApiKey?: string;
  baseUrl?: string;
  runCycle?: typeof runChannexAriDispatchCycle;
  disconnect?: () => Promise<void>;
  logger?: ChannexAriDispatchWorkerLogger;
  clock?: () => Date;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
};

function defaultLogger(): ChannexAriDispatchWorkerLogger {
  return {
    info(message, metadata) {
      console.log("[channex.ari-dispatch]", message, metadata ?? {});
    },
    error(message, metadata) {
      console.error("[channex.ari-dispatch]", message, metadata ?? {});
    },
  };
}

function publicErrorCode(error: unknown): string {
  const message =
    error instanceof Error ? String(error.message ?? "").trim() : "";

  return /^[A-Z0-9_]+$/.test(message) && message.length <= 128
    ? message
    : "CHANNEX_ARI_DISPATCH_WORKER_TICK_FAILED";
}

function readClock(clock: () => Date): Date {
  const now = new Date(clock());

  if (Number.isNaN(now.getTime())) {
    throw new Error("CHANNEX_ARI_DISPATCH_WORKER_CLOCK_INVALID");
  }

  return now;
}

export function createChannexAriDispatchWorker(
  input: CreateChannexAriDispatchWorkerInput
): ChannexAriDispatchWorkerController {
  const runCycle = input.runCycle ?? runChannexAriDispatchCycle;
  const disconnect = input.disconnect ?? (async () => undefined);
  const logger = input.logger ?? defaultLogger();
  const clock = input.clock ?? (() => new Date());
  const setIntervalFn = input.setIntervalFn ?? setInterval;
  const clearIntervalFn = input.clearIntervalFn ?? clearInterval;

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
    if (!input.activation.enabled) {
      logger.info("tick skipped because worker activation is disabled", {
        activationSource: input.activation.source,
        activationRawValue: input.activation.rawValue,
      });
      return;
    }

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
        const cycleStartedAt = readClock(clock);
        const result = await runCycle({
          db: input.db,
          selection: {
            now: cycleStartedAt,
            limit: input.config.selectionLimit,
            candidateScanLimit: input.config.candidateScanLimit,
          },
          credentialsSecret: input.credentialsSecret,
          globalApiKey: input.globalApiKey,
          baseUrl: input.baseUrl,
          timeoutMs: input.config.timeoutMs,
          jitterMs: input.config.jitterMs,
          leaseMs: input.config.leaseMs,
          completionReserveMs: input.config.completionReserveMs,
          clock,
        });

        logger.info("tick completed", {
          selectedCount: result.batch.selectedCount,
          recoveredCount: result.batch.recoveredCount,
          executedCount: result.batch.executedCount,
          failedCount: result.batch.failedCount,
        });
      } catch (error) {
        logger.error("tick failed", {
          errorCode: publicErrorCode(error),
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
      throw new Error("CHANNEX_ARI_DISPATCH_WORKER_STOPPING");
    }

    started = true;
    logger.info("boot", {
      ...input.config,
      activationEnabled: input.activation.enabled,
      activationSource: input.activation.source,
      activationRawValue: input.activation.rawValue,
    });

    if (!input.activation.enabled) {
      logger.info("worker idle because activation is disabled", {
        activationSource: input.activation.source,
        activationRawValue: input.activation.rawValue,
      });
      return;
    }

    await tick();

    if (!stopping) {
      interval = setIntervalFn(() => {
        void tick();
      }, input.config.pollMs);
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
