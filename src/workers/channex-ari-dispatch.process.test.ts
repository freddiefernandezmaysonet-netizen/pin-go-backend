import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  CHANNEX_ARI_DISPATCH_DISABLED_KEEPALIVE_MS,
  isChannexAriDispatchProcessEntrypoint,
  resolveChannexAriDispatchProviderConfig,
  startChannexAriDispatchProcess,
} from "./channex-ari-dispatch.process";
import type { ChannexAriDispatchWorkerController } from "./channex-ari-dispatch.worker";

function createWorkerController() {
  let startCalls = 0;
  const stopCalls: string[] = [];
  const worker: ChannexAriDispatchWorkerController = {
    async start() {
      startCalls += 1;
    },
    async stop(signal = "MANUAL") {
      stopCalls.push(signal);
    },
    async tick() {},
    isRunning: () => false,
    isStopping: () => false,
  };

  return {
    worker,
    startCalls: () => startCalls,
    stopCalls,
  };
}

test("detects only the exact direct process entrypoint", () => {
  const entrypoint = "/tmp/channex-ari-dispatch.process.ts";
  const moduleUrl = pathToFileURL(entrypoint).href;

  assert.equal(
    isChannexAriDispatchProcessEntrypoint(entrypoint, moduleUrl),
    true
  );
  assert.equal(
    isChannexAriDispatchProcessEntrypoint(
      "/tmp/another-worker.ts",
      moduleUrl
    ),
    false
  );
  assert.equal(isChannexAriDispatchProcessEntrypoint("", moduleUrl), false);
});

test("boots disabled by default, creates no ARI cycle and holds the process idle", async () => {
  const controller = createWorkerController();
  const db = { marker: "db" } as any;
  const disconnect = async () => undefined;
  const workerInputs: any[] = [];
  const intervals: Array<{ callback: () => void; delay: number; handle: NodeJS.Timeout }> = [];
  const cleared: NodeJS.Timeout[] = [];

  const runtime = await startChannexAriDispatchProcess({
    db,
    disconnect,
    env: {} as NodeJS.ProcessEnv,
    createWorker: ((input: any) => {
      workerInputs.push(input);
      return controller.worker;
    }) as any,
    setIntervalFn: (((callback: () => void, delay: number) => {
      const handle = { index: intervals.length } as unknown as NodeJS.Timeout;
      intervals.push({ callback, delay, handle });
      return handle;
    }) as unknown) as typeof setInterval,
    clearIntervalFn: (((handle: NodeJS.Timeout) => {
      cleared.push(handle);
    }) as unknown) as typeof clearInterval,
  });

  assert.equal(controller.startCalls(), 1);
  assert.equal(workerInputs.length, 1);
  assert.equal(workerInputs[0].db, db);
  assert.equal(workerInputs[0].disconnect, disconnect);
  assert.deepEqual(workerInputs[0].activation, {
    enabled: false,
    source: "DEFAULT_DISABLED",
    rawValue: null,
  });
  assert.deepEqual(workerInputs[0].config, {
    pollMs: 10_000,
    selectionLimit: 25,
    candidateScanLimit: 250,
    leaseMs: 120_000,
    timeoutMs: 15_000,
    completionReserveMs: 5_000,
    jitterMs: 0,
  });
  assert.equal(workerInputs[0].credentialsSecret, undefined);
  assert.equal(workerInputs[0].globalApiKey, undefined);
  assert.equal(workerInputs[0].baseUrl, undefined);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].delay, CHANNEX_ARI_DISPATCH_DISABLED_KEEPALIVE_MS);
  assert.deepEqual(runtime.activation, workerInputs[0].activation);
  assert.deepEqual(runtime.config, workerInputs[0].config);
  assert.equal(runtime.worker, controller.worker);

  await runtime.stop("TEST");
  await runtime.stop("TEST_AGAIN");

  assert.deepEqual(cleared, [intervals[0].handle]);
  assert.deepEqual(controller.stopCalls, ["TEST"]);
});

test("forwards explicit activation, bounded config and credentials without idle keepalive", async () => {
  const controller = createWorkerController();
  const workerInputs: any[] = [];
  let processIntervalCalls = 0;
  const credentialsSecret = "private-credentials-secret";
  const globalApiKey = "private-ota-connection-api-key";
  const baseUrl = "https://staging.channex.io";
  const env = {
    CHANNEX_ARI_DISPATCH_ENABLED: "true",
    CHANNEX_ARI_DISPATCH_POLL_MS: "15000",
    CHANNEX_ARI_DISPATCH_SELECTION_LIMIT: "40",
    CHANNEX_ARI_DISPATCH_CANDIDATE_SCAN_LIMIT: "400",
    CHANNEX_ARI_DISPATCH_LEASE_MS: "180000",
    CHANNEX_ARI_DISPATCH_HTTP_TIMEOUT_MS: "30000",
    CHANNEX_ARI_DISPATCH_COMPLETION_RESERVE_MS: "10000",
    CHANNEX_ARI_DISPATCH_JITTER_MS: "2500",
    PMS_CREDENTIALS_SECRET: credentialsSecret,
    OTA_CONNECTION_API_KEY: globalApiKey,
    OTA_CONNECTION_PROVIDER_API_ORIGIN: baseUrl,
  } as NodeJS.ProcessEnv;
  const before = { ...env };

  const runtime = await startChannexAriDispatchProcess({
    db: {} as any,
    disconnect: async () => undefined,
    env,
    createWorker: ((input: any) => {
      workerInputs.push(input);
      return controller.worker;
    }) as any,
    setIntervalFn: (((_callback: () => void, _delay: number) => {
      processIntervalCalls += 1;
      return {} as NodeJS.Timeout;
    }) as unknown) as typeof setInterval,
  });

  assert.equal(controller.startCalls(), 1);
  assert.equal(processIntervalCalls, 0);
  assert.deepEqual(workerInputs[0].activation, {
    enabled: true,
    source: "EXPLICIT",
    rawValue: "true",
  });
  assert.deepEqual(workerInputs[0].config, {
    pollMs: 15_000,
    selectionLimit: 40,
    candidateScanLimit: 400,
    leaseMs: 180_000,
    timeoutMs: 30_000,
    completionReserveMs: 10_000,
    jitterMs: 2_500,
  });
  assert.equal(workerInputs[0].credentialsSecret, credentialsSecret);
  assert.equal(workerInputs[0].globalApiKey, globalApiKey);
  assert.equal(workerInputs[0].baseUrl, baseUrl);
  assert.deepEqual(env, before);

  const serializedRuntime = JSON.stringify(runtime);
  assert.equal(serializedRuntime.includes(credentialsSecret), false);
  assert.equal(serializedRuntime.includes(globalApiKey), false);
  assert.equal(serializedRuntime.includes(baseUrl), false);
});

test("production dispatch accepts only the canonical OTA credential and app origin", () => {
  assert.deepEqual(
    resolveChannexAriDispatchProviderConfig({
      NODE_ENV: "production",
      OTA_CONNECTION_API_KEY: " production-key ",
      OTA_CONNECTION_PROVIDER_API_ORIGIN: "https://app.channex.io/",
      CHANNEX_API_KEY: "legacy-key-must-be-ignored",
      CHANNEX_API_BASE_URL: "https://staging.channex.io",
    } as NodeJS.ProcessEnv),
    {
      apiKey: "production-key",
      baseUrl: "https://app.channex.io",
    }
  );
});

test("active production dispatch fails before worker construction for legacy-only configuration", async () => {
  let createCalls = 0;

  await assert.rejects(
    () =>
      startChannexAriDispatchProcess({
        db: {} as any,
        disconnect: async () => undefined,
        env: {
          NODE_ENV: "production",
          CHANNEX_ARI_DISPATCH_ENABLED: "true",
          CHANNEX_API_KEY: "legacy-key",
          CHANNEX_API_BASE_URL: "https://staging.channex.io",
        } as NodeJS.ProcessEnv,
        createWorker: ((() => {
          createCalls += 1;
          return createWorkerController().worker;
        }) as unknown) as any,
      }),
    /CHANNEX_ARI_OTA_API_KEY_REQUIRED/
  );

  assert.equal(createCalls, 0);
});

test("active production dispatch rejects every non-canonical OTA origin before worker construction", async () => {
  for (const origin of [
    undefined,
    "https://staging.channex.io",
    "https://api.channex.io",
    "https://app.channex.io/api/v1",
    "https://app.channex.io?target=staging",
  ]) {
    let createCalls = 0;

    await assert.rejects(
      () =>
        startChannexAriDispatchProcess({
          db: {} as any,
          disconnect: async () => undefined,
          env: {
            NODE_ENV: "production",
            CHANNEX_ARI_DISPATCH_ENABLED: "true",
            OTA_CONNECTION_API_KEY: "production-key",
            OTA_CONNECTION_PROVIDER_API_ORIGIN: origin,
          } as NodeJS.ProcessEnv,
          createWorker: ((() => {
            createCalls += 1;
            return createWorkerController().worker;
          }) as unknown) as any,
        }),
      origin === undefined || origin.includes("/api/") || origin.includes("?")
        ? /CHANNEX_ARI_OTA_ORIGIN_INVALID/
        : /CHANNEX_ARI_PRODUCTION_ORIGIN_REQUIRED/
    );

    assert.equal(createCalls, 0);
  }
});

test("rejects invalid activation before constructing a worker", async () => {
  let createCalls = 0;

  await assert.rejects(
    () =>
      startChannexAriDispatchProcess({
        db: {} as any,
        disconnect: async () => undefined,
        env: {
          CHANNEX_ARI_DISPATCH_ENABLED: "maybe",
        } as NodeJS.ProcessEnv,
        createWorker: ((() => {
          createCalls += 1;
          return createWorkerController().worker;
        }) as unknown) as any,
      }),
    /CHANNEX_ARI_DISPATCH_ENABLED_INVALID/
  );

  assert.equal(createCalls, 0);
});

test("rejects invalid operational config before constructing a worker", async () => {
  let createCalls = 0;

  await assert.rejects(
    () =>
      startChannexAriDispatchProcess({
        db: {} as any,
        disconnect: async () => undefined,
        env: {
          CHANNEX_ARI_DISPATCH_ENABLED: "false",
          CHANNEX_ARI_DISPATCH_POLL_MS: "999",
        } as NodeJS.ProcessEnv,
        createWorker: ((() => {
          createCalls += 1;
          return createWorkerController().worker;
        }) as unknown) as any,
      }),
    /CHANNEX_ARI_DISPATCH_POLL_MS_INVALID/
  );

  assert.equal(createCalls, 0);
});

test("propagates worker boot failure and does not create disabled keepalive", async () => {
  let intervalCalls = 0;

  await assert.rejects(
    () =>
      startChannexAriDispatchProcess({
        db: {} as any,
        disconnect: async () => undefined,
        env: {} as NodeJS.ProcessEnv,
        createWorker: ((() => ({
          async start() {
            throw new Error("WORKER_BOOT_FAILED");
          },
          async stop() {},
          async tick() {},
          isRunning: () => false,
          isStopping: () => false,
        })) as unknown) as any,
        setIntervalFn: ((() => {
          intervalCalls += 1;
          return {} as NodeJS.Timeout;
        }) as unknown) as typeof setInterval,
      }),
    /WORKER_BOOT_FAILED/
  );

  assert.equal(intervalCalls, 0);
});
