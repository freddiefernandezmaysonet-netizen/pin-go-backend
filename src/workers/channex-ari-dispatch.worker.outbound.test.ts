import assert from "node:assert/strict";
import test from "node:test";

import {
  createChannexAriDispatchWorker,
  type ChannexAriDispatchWorkerLogger,
} from "./channex-ari-dispatch.worker";

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

test("the default worker path runs the composed outbound cycle with exact config", async () => {
  const logs = createLogger();
  const db = { marker: "db" } as any;
  const clock = () => new Date("2026-07-29T14:00:00.000Z");
  const calls: any[] = [];
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
    runOutboundCycle: (async (input: any) => {
      calls.push(input);
      return {
        cycleStartedAt: new Date("2026-07-29T14:00:00.000Z"),
        dispatchStartedAt: new Date("2026-07-29T14:00:01.000Z"),
        materialization: {
          outcome: "MATERIALIZED",
          claimedCount: 2,
          supersededCount: 3,
          delivery: { delivery: { id: "delivery-1" } },
        },
        dispatch: {
          selection: { selectedCount: 2 },
          batch: {
            selectedCount: 2,
            recoveredCount: 1,
            executedCount: 1,
            failedCount: 0,
            results: [],
          },
        },
      } as any;
    }) as any,
  });

  await worker.tick();

  assert.deepEqual(calls, [
    {
      db,
      selectionLimit: CONFIG.selectionLimit,
      candidateScanLimit: CONFIG.candidateScanLimit,
      leaseMs: CONFIG.leaseMs,
      timeoutMs: CONFIG.timeoutMs,
      completionReserveMs: CONFIG.completionReserveMs,
      jitterMs: CONFIG.jitterMs,
      credentialsSecret,
      globalApiKey,
      baseUrl: "https://staging.example.test",
      clock,
    },
  ]);
  assert.deepEqual(logs.info, [
    {
      message: "tick completed",
      metadata: {
        selectedCount: 2,
        recoveredCount: 1,
        executedCount: 1,
        failedCount: 0,
        materializationOutcome: "MATERIALIZED",
        materializationClaimedCount: 2,
        materializationSupersededCount: 3,
      },
    },
  ]);
  assert.deepEqual(logs.error, []);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(credentialsSecret), false);
  assert.equal(serialized.includes(globalApiKey), false);
});

test("reports a pre-claim materialization failure while still logging dispatch success", async () => {
  const logs = createLogger();

  const worker = createChannexAriDispatchWorker({
    db: {} as any,
    config: CONFIG,
    activation: ENABLED,
    logger: logs.logger,
    runOutboundCycle: (async () => ({
      cycleStartedAt: new Date("2026-07-29T14:00:00.000Z"),
      dispatchStartedAt: new Date("2026-07-29T14:00:01.000Z"),
      materialization: {
        outcome: "FAILED_BEFORE_CLAIM",
        startedAt: new Date("2026-07-29T14:00:00.000Z"),
        errorCode: "CHANNEX_ARI_OUTBOX_RECOVERY_FAILED",
      },
      dispatch: {
        selection: { selectedCount: 0 },
        batch: {
          selectedCount: 0,
          recoveredCount: 0,
          executedCount: 0,
          failedCount: 0,
          results: [],
        },
      },
    })) as any,
  });

  await worker.tick();

  assert.deepEqual(logs.info[0], {
    message: "tick completed",
    metadata: {
      selectedCount: 0,
      recoveredCount: 0,
      executedCount: 0,
      failedCount: 0,
      materializationOutcome: "FAILED_BEFORE_CLAIM",
      materializationErrorCode: "CHANNEX_ARI_OUTBOX_RECOVERY_FAILED",
    },
  });
  assert.deepEqual(logs.error, []);
});
