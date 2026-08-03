import assert from "node:assert/strict";
import test from "node:test";

import { runChannexAriOutboundCycle } from "./channex-ari-outbound-cycle.service";

const CYCLE_STARTED_AT = new Date("2026-07-29T14:00:00.000Z");
const DISPATCH_STARTED_AT = new Date("2026-07-29T14:00:01.000Z");
const CREDENTIALS_SECRET = "secret-pms-credentials-key";
const GLOBAL_API_KEY = "secret-global-key";

function createClock(...dates: Date[]) {
  let index = 0;

  return () => {
    const value = dates[Math.min(index, dates.length - 1)];
    index += 1;
    return new Date(value);
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    db: { marker: "db" } as any,
    selectionLimit: 25,
    candidateScanLimit: 250,
    leaseMs: 120_000,
    timeoutMs: 15_000,
    completionReserveMs: 5_000,
    jitterMs: 321,
    credentialsSecret: CREDENTIALS_SECRET,
    globalApiKey: GLOBAL_API_KEY,
    baseUrl: "https://staging.example.test",
    ...overrides,
  } as any;
}

test("materializes before dispatch and forwards the exact certified configuration", async () => {
  const order: string[] = [];
  const materializeCalls: any[] = [];
  const dispatchCalls: any[] = [];
  const transport = { marker: "transport" } as any;
  const claimTokenFactory = () => "claim-1";
  const clock = createClock(CYCLE_STARTED_AT, DISPATCH_STARTED_AT);
  const materialization = {
    outcome: "MATERIALIZED",
    claimedCount: 1,
    supersededCount: 0,
    delivery: { delivery: { id: "delivery-1" } },
  };
  const dispatch = {
    selection: { selectedCount: 1 },
    batch: {
      selectedCount: 1,
      recoveredCount: 0,
      executedCount: 1,
      failedCount: 0,
      results: [],
    },
  };
  const input = baseInput({ transport, claimTokenFactory, clock });

  const result = await runChannexAriOutboundCycle({
    ...input,
    materialize: (async (received: any) => {
      order.push("materialize");
      materializeCalls.push(received);
      return materialization as any;
    }) as any,
    dispatch: (async (received: any) => {
      order.push("dispatch");
      dispatchCalls.push(received);
      return dispatch as any;
    }) as any,
  });

  assert.deepEqual(order, ["materialize", "dispatch"]);
  assert.deepEqual(materializeCalls, [
    {
      db: input.db,
      now: CYCLE_STARTED_AT,
      claimLeaseMs: 120_000,
      claimLimit: 25,
      recoveryLimit: 25,
      jitterMs: 321,
      claimTokenFactory,
      clock,
    },
  ]);
  assert.deepEqual(dispatchCalls, [
    {
      db: input.db,
      selection: {
        now: DISPATCH_STARTED_AT,
        limit: 25,
        candidateScanLimit: 250,
      },
      credentialsSecret: CREDENTIALS_SECRET,
      globalApiKey: GLOBAL_API_KEY,
      baseUrl: "https://staging.example.test",
      timeoutMs: 15_000,
      jitterMs: 321,
      leaseMs: 120_000,
      completionReserveMs: 5_000,
      transport,
      clock,
    },
  ]);
  assert.deepEqual(result, {
    cycleStartedAt: CYCLE_STARTED_AT,
    dispatchStartedAt: DISPATCH_STARTED_AT,
    materialization,
    dispatch,
  });
});

test("continues dispatch when materialization fails before owning an outbox claim", async () => {
  let dispatchCalls = 0;

  const result = await runChannexAriOutboundCycle({
    ...baseInput({ clock: createClock(CYCLE_STARTED_AT, DISPATCH_STARTED_AT) }),
    materialize: (async () => {
      throw new Error("CHANNEX_ARI_OUTBOX_RECOVERY_FAILED");
    }) as any,
    dispatch: (async () => {
      dispatchCalls += 1;
      return {
        selection: { selectedCount: 0 },
        batch: {
          selectedCount: 0,
          recoveredCount: 0,
          executedCount: 0,
          failedCount: 0,
          results: [],
        },
      } as any;
    }) as any,
  });

  assert.equal(dispatchCalls, 1);
  assert.deepEqual(result.materialization, {
    outcome: "FAILED_BEFORE_CLAIM",
    startedAt: CYCLE_STARTED_AT,
    errorCode: "CHANNEX_ARI_OUTBOX_RECOVERY_FAILED",
  });
});

test("sanitizes unsafe materialization errors while preserving dispatch", async () => {
  const result = await runChannexAriOutboundCycle({
    ...baseInput({ clock: createClock(CYCLE_STARTED_AT, DISPATCH_STARTED_AT) }),
    materialize: (async () => {
      throw new Error("database failed apiKey=super-secret");
    }) as any,
    dispatch: (async () => ({
      selection: { selectedCount: 0 },
      batch: {
        selectedCount: 0,
        recoveredCount: 0,
        executedCount: 0,
        failedCount: 0,
        results: [],
      },
    })) as any,
  });

  assert.deepEqual(result.materialization, {
    outcome: "FAILED_BEFORE_CLAIM",
    startedAt: CYCLE_STARTED_AT,
    errorCode: "CHANNEX_ARI_OUTBOUND_MATERIALIZATION_FAILED",
  });
  assert.equal(JSON.stringify(result).includes("super-secret"), false);
  assert.equal(JSON.stringify(result).includes(CREDENTIALS_SECRET), false);
  assert.equal(JSON.stringify(result).includes(GLOBAL_API_KEY), false);
});

test("propagates dispatch failure after materialization completes", async () => {
  let materializeCalls = 0;
  let dispatchCalls = 0;

  await assert.rejects(
    () =>
      runChannexAriOutboundCycle({
        ...baseInput({ clock: createClock(CYCLE_STARTED_AT, DISPATCH_STARTED_AT) }),
        materialize: (async () => {
          materializeCalls += 1;
          return { outcome: "EMPTY", claimedCount: 0 } as any;
        }) as any,
        dispatch: (async () => {
          dispatchCalls += 1;
          throw new Error("DISPATCH_FAILED");
        }) as any,
      }),
    /DISPATCH_FAILED/
  );

  assert.equal(materializeCalls, 1);
  assert.equal(dispatchCalls, 1);
});

test("rejects an invalid initial clock before invoking either component", async () => {
  let materializeCalls = 0;
  let dispatchCalls = 0;

  await assert.rejects(
    () =>
      runChannexAriOutboundCycle({
        ...baseInput({ clock: () => new Date("invalid") }),
        materialize: (async () => {
          materializeCalls += 1;
          return {} as any;
        }) as any,
        dispatch: (async () => {
          dispatchCalls += 1;
          return {} as any;
        }) as any,
      }),
    /CHANNEX_ARI_OUTBOUND_CYCLE_STARTED_AT_INVALID/
  );

  assert.equal(materializeCalls, 0);
  assert.equal(dispatchCalls, 0);
});

test("rejects a backward clock after materialization and before dispatch", async () => {
  let materializeCalls = 0;
  let dispatchCalls = 0;

  await assert.rejects(
    () =>
      runChannexAriOutboundCycle({
        ...baseInput({
          clock: createClock(
            CYCLE_STARTED_AT,
            new Date(CYCLE_STARTED_AT.getTime() - 1)
          ),
        }),
        materialize: (async () => {
          materializeCalls += 1;
          return { outcome: "EMPTY", claimedCount: 0 } as any;
        }) as any,
        dispatch: (async () => {
          dispatchCalls += 1;
          return {} as any;
        }) as any,
      }),
    /CHANNEX_ARI_OUTBOUND_CLOCK_MOVED_BACKWARD/
  );

  assert.equal(materializeCalls, 1);
  assert.equal(dispatchCalls, 0);
});
