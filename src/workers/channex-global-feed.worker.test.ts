import assert from "node:assert/strict";
import test from "node:test";
import type { ChannexGlobalFeedExecutionResult } from "../pms/ingest/channex-global-feed.service";
import {
  createChannexGlobalFeedWorker,
  type ChannexGlobalFeedWorkerLogger,
} from "./channex-global-feed.worker";

const config = {
  pollMs: 60_000,
  leaseMs: 600_000,
  maxSourcesPerRun: 25,
  maxRevisionsPerRun: 500,
};

function completedResult(
  overrides: Partial<ChannexGlobalFeedExecutionResult> = {}
): ChannexGlobalFeedExecutionResult {
  return {
    status: "COMPLETED",
    sourceCount: 1,
    fetchedSourceCount: 1,
    failedSourceCount: 0,
    fetchedRevisionCount: 0,
    acknowledgedRevisionCount: 0,
    failedRevisionCount: 0,
    duplicateRevisionCount: 0,
    emptyFeed: true,
    sourceErrors: [],
    revisions: [],
    connectionCount: 1,
    credentialSourceCount: 1,
    discoveredRevisionCount: 0,
    selectedRevisionCount: 0,
    truncatedRevisionCount: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function logger() {
  const info: Array<{ message: string; metadata?: Record<string, unknown> }> = [];
  const errors: Array<{ message: string; metadata?: Record<string, unknown> }> = [];

  const value: ChannexGlobalFeedWorkerLogger = {
    info(message, metadata) {
      info.push({ message, metadata });
    },
    error(message, metadata) {
      errors.push({ message, metadata });
    },
  };

  return { value, info, errors };
}

test("start runs immediately and schedules polling with the configured interval", async () => {
  let runCalls = 0;
  let scheduledDelay: number | null = null;
  let scheduledCallback: (() => void) | null = null;
  const fakeHandle = {} as NodeJS.Timeout;
  const logs = logger();

  const worker = createChannexGlobalFeedWorker({
    config,
    logger: logs.value,
    runOnce: async () => {
      runCalls += 1;
      return completedResult();
    },
    disconnect: async () => undefined,
    setIntervalFn: ((callback: () => void, delay?: number) => {
      scheduledCallback = callback;
      scheduledDelay = delay ?? null;
      return fakeHandle;
    }) as typeof setInterval,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
  });

  await worker.start();

  assert.equal(runCalls, 1);
  assert.equal(scheduledDelay, config.pollMs);
  assert.equal(typeof scheduledCallback, "function");
  assert.equal(worker.isRunning(), false);
  assert.equal(logs.info[0]?.message, "boot");
  assert.equal(logs.info[1]?.message, "tick completed");
});

test("scheduled callback starts another tick", async () => {
  let runCalls = 0;
  let scheduledCallback: (() => void) | null = null;

  const worker = createChannexGlobalFeedWorker({
    config,
    runOnce: async () => {
      runCalls += 1;
      return completedResult();
    },
    disconnect: async () => undefined,
    setIntervalFn: ((callback: () => void) => {
      scheduledCallback = callback;
      return {} as NodeJS.Timeout;
    }) as typeof setInterval,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
  });

  await worker.start();
  scheduledCallback?.();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(runCalls, 2);
});

test("does not overlap ticks when a previous run is still active", async () => {
  let runCalls = 0;
  const firstRun = deferred<ChannexGlobalFeedExecutionResult>();
  const logs = logger();

  const worker = createChannexGlobalFeedWorker({
    config,
    logger: logs.value,
    runOnce: async () => {
      runCalls += 1;
      return firstRun.promise;
    },
    disconnect: async () => undefined,
  });

  const activeTick = worker.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(worker.isRunning(), true);
  await worker.tick();
  assert.equal(runCalls, 1);
  assert.equal(
    logs.info.some(
      (entry) => entry.message === "tick skipped because previous tick is still running"
    ),
    true
  );

  firstRun.resolve(completedResult());
  await activeTick;
  assert.equal(worker.isRunning(), false);
});

test("stop clears polling and waits for the active tick before disconnecting", async () => {
  const run = deferred<ChannexGlobalFeedExecutionResult>();
  const lifecycle: string[] = [];
  const fakeHandle = {} as NodeJS.Timeout;

  const worker = createChannexGlobalFeedWorker({
    config,
    runOnce: async () => {
      lifecycle.push("run-started");
      const result = await run.promise;
      lifecycle.push("run-finished");
      return result;
    },
    disconnect: async () => {
      lifecycle.push("disconnected");
    },
    setIntervalFn: (() => fakeHandle) as typeof setInterval,
    clearIntervalFn: ((handle: NodeJS.Timeout) => {
      assert.equal(handle, fakeHandle);
      lifecycle.push("interval-cleared");
    }) as typeof clearInterval,
  });

  const startPromise = worker.start();
  await new Promise<void>((resolve) => setImmediate(resolve));

  const stopPromise = worker.stop("SIGTERM");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(worker.isStopping(), true);
  assert.equal(lifecycle.includes("disconnected"), false);

  run.resolve(completedResult());
  await Promise.all([startPromise, stopPromise]);

  assert.deepEqual(lifecycle, [
    "run-started",
    "run-finished",
    "disconnected",
  ]);
});

test("stop clears an already scheduled interval", async () => {
  const fakeHandle = {} as NodeJS.Timeout;
  let cleared = 0;

  const worker = createChannexGlobalFeedWorker({
    config,
    runOnce: async () => completedResult(),
    disconnect: async () => undefined,
    setIntervalFn: (() => fakeHandle) as typeof setInterval,
    clearIntervalFn: ((handle: NodeJS.Timeout) => {
      assert.equal(handle, fakeHandle);
      cleared += 1;
    }) as typeof clearInterval,
  });

  await worker.start();
  await worker.stop("SIGTERM");

  assert.equal(cleared, 1);
});

test("disconnect executes only once across repeated stop calls", async () => {
  let disconnectCalls = 0;

  const worker = createChannexGlobalFeedWorker({
    config,
    runOnce: async () => completedResult(),
    disconnect: async () => {
      disconnectCalls += 1;
    },
    setIntervalFn: (() => ({} as NodeJS.Timeout)) as typeof setInterval,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
  });

  await worker.start();
  await Promise.all([worker.stop("SIGTERM"), worker.stop("SIGINT")]);
  await worker.stop("MANUAL");

  assert.equal(disconnectCalls, 1);
});

test("tick failures are logged and do not reject the scheduler", async () => {
  const logs = logger();

  const worker = createChannexGlobalFeedWorker({
    config,
    logger: logs.value,
    runOnce: async () => {
      throw new Error("Feed unavailable");
    },
    disconnect: async () => undefined,
  });

  await worker.tick();

  assert.equal(worker.isRunning(), false);
  assert.deepEqual(logs.errors, [
    {
      message: "tick failed",
      metadata: { error: "Feed unavailable" },
    },
  ]);
});

test("start is idempotent and does not schedule a second interval", async () => {
  let runCalls = 0;
  let intervalCalls = 0;
  const logs = logger();

  const worker = createChannexGlobalFeedWorker({
    config,
    logger: logs.value,
    runOnce: async () => {
      runCalls += 1;
      return completedResult();
    },
    disconnect: async () => undefined,
    setIntervalFn: (() => {
      intervalCalls += 1;
      return {} as NodeJS.Timeout;
    }) as typeof setInterval,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
  });

  await worker.start();
  await worker.start();

  assert.equal(runCalls, 1);
  assert.equal(intervalCalls, 1);
  assert.equal(
    logs.info.some(
      (entry) => entry.message === "start skipped because worker is already running"
    ),
    true
  );
});

test("ticks are skipped once shutdown begins", async () => {
  let runCalls = 0;

  const worker = createChannexGlobalFeedWorker({
    config,
    runOnce: async () => {
      runCalls += 1;
      return completedResult();
    },
    disconnect: async () => undefined,
  });

  await worker.stop("MANUAL");
  await worker.tick();

  assert.equal(runCalls, 0);
});
