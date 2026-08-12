import assert from "node:assert/strict";
import test from "node:test";

import {
  createChannexAriDispatchWorker,
  type ChannexAriDispatchWorkerLogger,
} from "./channex-ari-dispatch.worker";

const NOW = new Date("2026-07-29T14:00:00.000Z");
const CONFIG = {
  pollMs: 10_000,
  selectionLimit: 25,
  candidateScanLimit: 250,
  leaseMs: 120_000,
  timeoutMs: 15_000,
  completionReserveMs: 5_000,
  jitterMs: 500,
};
const ENABLED = {
  enabled: true,
  source: "EXPLICIT" as const,
  rawValue: "true",
};
const DISABLED = {
  enabled: false,
  source: "DEFAULT_DISABLED" as const,
  rawValue: null,
};

function createLogger() {
  const info: Array<{ message: string; metadata?: Record<string, unknown> }> = [];
  const error: Array<{ message: string; metadata?: Record<string, unknown> }> = [];
  const logger: ChannexAriDispatchWorkerLogger = {
    info(message, metadata) {
      info.push({ message, metadata });
    },
    error(message, metadata) {
      error.push({ message, metadata });
    },
  };

  return { logger, info, error };
}

function successfulCycleResult() {
  return {
    selection: {
      selectedCount: 2,
      actions: [],
    },
    batch: {
      selectedCount: 2,
      recoveredCount: 1,
      executedCount: 1,
      failedCount: 0,
      results: [],
    },
  } as any;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

test("remains idle by default and performs no database cycle or scheduling", async () => {
  const logs = createLogger();
  let cycleCalls = 0;
  let intervalCalls = 0;
  let disconnectCalls = 0;
  const worker = createChannexAriDispatchWorker({
    db: {} as any,
    config: CONFIG,
    activation: DISABLED,
    logger: logs.logger,
    runCycle: (async () => {
      cycleCalls += 1;
      return successfulCycleResult();
    }) as any,
    setIntervalFn: ((() => {
      intervalCalls += 1;
      return {} as NodeJS.Timeout;
    }) as unknown) as typeof setInterval,
    disconnect: async () => {
      disconnectCalls += 1;
    },
  });

  await worker.start();
  await worker.tick();

  assert.equal(cycleCalls, 0);
  assert.equal(intervalCalls, 0);
  assert.equal(worker.isRunning(), false);
  assert.deepEqual(logs.info[0], {
    message: "boot",
    metadata: {
      ...CONFIG,
      activationEnabled: false,
      activationSource: "DEFAULT_DISABLED",
      activationRawValue: null,
    },
  });
  assert.equal(
    logs.info.some((entry) =>
      entry.message.includes("worker idle because activation is disabled")
    ),
    true
  );
  assert.equal(
    logs.info.some((entry) =>
      entry.message.includes("tick skipped because worker activation is disabled")
    ),
    true
  );

  await worker.stop("TEST");
  await worker.stop("TEST_AGAIN");
  assert.equal(disconnectCalls, 1);
});

test("runs one immediate cycle and schedules subsequent ticks when explicitly enabled", async () => {
  const logs = createLogger();
  const db = { marker: "db" } as any;
  const clock = () => new Date(NOW);
  const cycleCalls: any[] = [];
  const intervals: Array<{ callback: () => void; delay: number }> = [];
  const credentialsSecret = "private-credentials-secret";
  const globalApiKey = "private-global-api-key";

  const worker = createChannexAriDispatchWorker({
    db,
    config: CONFIG,
    activation: ENABLED,
    credentialsSecret,
    globalApiKey,
    baseUrl: "https://staging.example.test",
    logger: logs.logger,
    clock,
    runCycle: (async (input: any) => {
      cycleCalls.push(input);
      return successfulCycleResult();
    }) as any,
    setIntervalFn: (((callback: () => void, delay: number) => {
      intervals.push({ callback, delay });
      return { marker: "interval" } as unknown as NodeJS.Timeout;
    }) as unknown) as typeof setInterval,
  });

  await worker.start();

  assert.equal(cycleCalls.length, 1);
  assert.deepEqual(cycleCalls[0], {
    db,
    selection: {
      now: NOW,
      limit: CONFIG.selectionLimit,
      candidateScanLimit: CONFIG.candidateScanLimit,
    },
    credentialsSecret,
    globalApiKey,
    baseUrl: "https://staging.example.test",
    timeoutMs: CONFIG.timeoutMs,
    jitterMs: CONFIG.jitterMs,
    leaseMs: CONFIG.leaseMs,
    completionReserveMs: CONFIG.completionReserveMs,
    clock,
  });
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].delay, CONFIG.pollMs);
  assert.deepEqual(logs.info.at(-1), {
    message: "tick completed",
    metadata: {
      selectedCount: 2,
      recoveredCount: 1,
      executedCount: 1,
      failedCount: 0,
    },
  });

  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes(credentialsSecret), false);
  assert.equal(serializedLogs.includes(globalApiKey), false);
});

test("prevents overlapping cycles", async () => {
  const logs = createLogger();
  const pending = deferred<any>();
  let cycleCalls = 0;
  const worker = createChannexAriDispatchWorker({
    db: {} as any,
    config: CONFIG,
    activation: ENABLED,
    logger: logs.logger,
    clock: () => new Date(NOW),
    runCycle: (async () => {
      cycleCalls += 1;
      return pending.promise;
    }) as any,
  });

  const firstTick = worker.tick();
  await Promise.resolve();
  assert.equal(worker.isRunning(), true);

  await worker.tick();
  assert.equal(cycleCalls, 1);
  assert.equal(
    logs.info.some(
      (entry) => entry.message === "tick skipped because previous tick is still running"
    ),
    true
  );

  pending.resolve(successfulCycleResult());
  await firstTick;
  assert.equal(worker.isRunning(), false);
});

test("sanitizes unsafe cycle failures and preserves stable public error codes", async () => {
  const unsafeLogs = createLogger();
  const unsafeWorker = createChannexAriDispatchWorker({
    db: {} as any,
    config: CONFIG,
    activation: ENABLED,
    logger: unsafeLogs.logger,
    runCycle: (async () => {
      throw new Error("request failed with apiKey=super-secret");
    }) as any,
  });

  await unsafeWorker.tick();
  assert.deepEqual(unsafeLogs.error, [
    {
      message: "tick failed",
      metadata: {
        errorCode: "CHANNEX_ARI_DISPATCH_WORKER_TICK_FAILED",
      },
    },
  ]);
  assert.equal(JSON.stringify(unsafeLogs).includes("super-secret"), false);

  const stableLogs = createLogger();
  const stableWorker = createChannexAriDispatchWorker({
    db: {} as any,
    config: CONFIG,
    activation: ENABLED,
    logger: stableLogs.logger,
    runCycle: (async () => {
      throw new Error("CHANNEX_ARI_GLOBAL_API_KEY_REQUIRED");
    }) as any,
  });

  await stableWorker.tick();
  assert.deepEqual(stableLogs.error[0], {
    message: "tick failed",
    metadata: {
      errorCode: "CHANNEX_ARI_GLOBAL_API_KEY_REQUIRED",
    },
  });
});

test("rejects an invalid worker clock without invoking the cycle", async () => {
  const logs = createLogger();
  let cycleCalls = 0;
  const worker = createChannexAriDispatchWorker({
    db: {} as any,
    config: CONFIG,
    activation: ENABLED,
    logger: logs.logger,
    clock: () => new Date("invalid"),
    runCycle: (async () => {
      cycleCalls += 1;
      return successfulCycleResult();
    }) as any,
  });

  await worker.tick();

  assert.equal(cycleCalls, 0);
  assert.deepEqual(logs.error[0], {
    message: "tick failed",
    metadata: {
      errorCode: "CHANNEX_ARI_DISPATCH_WORKER_CLOCK_INVALID",
    },
  });
});

test("clears scheduling, waits for an active tick and disconnects exactly once", async () => {
  const logs = createLogger();
  const pending = deferred<any>();
  let clearCalls = 0;
  let disconnectCalls = 0;
  let cycleCalls = 0;
  let intervalHandle: NodeJS.Timeout | null = null;
  const worker = createChannexAriDispatchWorker({
    db: {} as any,
    config: CONFIG,
    activation: ENABLED,
    logger: logs.logger,
    clock: () => new Date(NOW),
    runCycle: (async () => {
      cycleCalls += 1;
      if (cycleCalls === 1) return successfulCycleResult();
      return pending.promise;
    }) as any,
    setIntervalFn: (((_callback: () => void) => {
      intervalHandle = { marker: "interval" } as unknown as NodeJS.Timeout;
      return intervalHandle;
    }) as unknown) as typeof setInterval,
    clearIntervalFn: (((handle: NodeJS.Timeout) => {
      assert.equal(handle, intervalHandle);
      clearCalls += 1;
    }) as unknown) as typeof clearInterval,
    disconnect: async () => {
      disconnectCalls += 1;
    },
  });

  await worker.start();
  const activeTick = worker.tick();
  await Promise.resolve();
  const stopPromise = worker.stop("SIGTERM");
  await Promise.resolve();

  assert.equal(worker.isStopping(), true);
  assert.equal(clearCalls, 1);
  assert.equal(disconnectCalls, 0);

  pending.resolve(successfulCycleResult());
  await activeTick;
  await stopPromise;
  await worker.stop("SIGTERM_AGAIN");

  assert.equal(disconnectCalls, 1);
  assert.equal(
    logs.info.some(
      (entry) =>
        entry.message === "shutdown completed" &&
        entry.metadata?.signal === "SIGTERM"
    ),
    true
  );
});

test("is idempotent on repeated start and refuses start after a pre-start stop", async () => {
  const logs = createLogger();
  let cycleCalls = 0;
  const worker = createChannexAriDispatchWorker({
    db: {} as any,
    config: CONFIG,
    activation: ENABLED,
    logger: logs.logger,
    runCycle: (async () => {
      cycleCalls += 1;
      return successfulCycleResult();
    }) as any,
    setIntervalFn: ((() => ({}) as NodeJS.Timeout) as unknown) as typeof setInterval,
  });

  await worker.start();
  await worker.start();
  assert.equal(cycleCalls, 1);
  assert.equal(
    logs.info.some((entry) => entry.message === "start skipped because worker is already running"),
    true
  );

  const stoppedBeforeStart = createChannexAriDispatchWorker({
    db: {} as any,
    config: CONFIG,
    activation: ENABLED,
    logger: createLogger().logger,
  });
  await stoppedBeforeStart.stop();
  await assert.rejects(
    () => stoppedBeforeStart.start(),
    /CHANNEX_ARI_DISPATCH_WORKER_STOPPING/
  );
});
