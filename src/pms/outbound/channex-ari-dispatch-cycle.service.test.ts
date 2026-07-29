import assert from "node:assert/strict";
import test from "node:test";

import { runChannexAriDispatchCycle } from "./channex-ari-dispatch-cycle.service";

const NOW = new Date("2026-07-28T12:00:00.000Z");
const CREDENTIALS_SECRET = "secret-pms-credentials-key";
const GLOBAL_API_KEY = "secret-global-channex-key";

function selectedAction(overrides: Record<string, unknown> = {}) {
  const propertyId = String(overrides.propertyId ?? "property-1");
  const messageKind = String(
    overrides.messageKind ?? "AVAILABILITY"
  ) as "AVAILABILITY" | "RATES_RESTRICTIONS";

  return {
    action: "CLAIM" as const,
    deliveryId: "delivery-1",
    organizationId: "org-1",
    propertyId,
    messageKind,
    partitionKey: `${propertyId}:${messageKind}`,
    readyAt: new Date("2026-07-28T11:59:00.000Z"),
    attemptCount: 0,
    ...overrides,
  } as any;
}

function selectionResult(actions = [selectedAction()]) {
  return {
    now: NOW,
    limit: 25,
    inspectedCount: actions.length,
    selectedCount: actions.length,
    actions,
    decisions: actions.map((action) => ({
      deliveryId: action.deliveryId,
      partitionKey: action.partitionKey,
      action: action.action,
      reason: null,
      nextEligibleAt: action.readyAt,
    })),
    query: {
      candidateScanLimit: 250,
      staleCandidateCount: 0,
      claimCandidateCount: actions.length,
      uniqueCandidateCount: actions.length,
      propertyStateCount: actions.length,
    },
  };
}

test("reads selection before running the selected batch and forwards the exact contract", async () => {
  const db = { marker: "db" } as any;
  const actions = [selectedAction()];
  const selection = selectionResult(actions);
  const batch = {
    selectedCount: 1,
    recoveredCount: 0,
    executedCount: 1,
    failedCount: 0,
    results: [
      {
        action: actions[0],
        outcome: "EXECUTED",
        credentials: {
          connectionId: "connection-1",
          organizationId: "org-1",
          source: "GLOBAL_MANAGED",
          connectionType: "WHITE_LABEL_GLOBAL",
          managedBy: "PinGo",
        },
        execution: { delivery: { id: "delivery-1" } },
      },
    ],
  };
  const selectionInput = {
    now: NOW,
    limit: 10,
    candidateScanLimit: 100,
  };
  const transport = { marker: "transport" } as any;
  const clock = () => new Date(NOW);
  const leaseTokenFactory = () => "lease-1";
  const order: string[] = [];
  const selectionCalls: any[] = [];
  const batchCalls: any[] = [];

  const result = await runChannexAriDispatchCycle({
    db,
    selection: selectionInput,
    credentialsSecret: CREDENTIALS_SECRET,
    globalApiKey: GLOBAL_API_KEY,
    baseUrl: "https://staging.example.test",
    timeoutMs: 15_000,
    jitterMs: 321,
    leaseMs: 120_000,
    completionReserveMs: 5_000,
    transport,
    clock,
    leaseTokenFactory,
    readSelection: (async (receivedDb: any, input: any) => {
      order.push("selection");
      selectionCalls.push({ receivedDb, input });
      return selection as any;
    }) as any,
    runBatch: (async (input: any) => {
      order.push("batch");
      batchCalls.push(input);
      return batch as any;
    }) as any,
  });

  assert.deepEqual(order, ["selection", "batch"]);
  assert.deepEqual(selectionCalls, [
    {
      receivedDb: db,
      input: selectionInput,
    },
  ]);
  assert.deepEqual(batchCalls, [
    {
      db,
      actions,
      credentialsSecret: CREDENTIALS_SECRET,
      globalApiKey: GLOBAL_API_KEY,
      baseUrl: "https://staging.example.test",
      timeoutMs: 15_000,
      jitterMs: 321,
      leaseMs: 120_000,
      completionReserveMs: 5_000,
      transport,
      clock,
      leaseTokenFactory,
    },
  ]);
  assert.deepEqual(result, { selection, batch });
  assert.equal(JSON.stringify(result).includes(CREDENTIALS_SECRET), false);
  assert.equal(JSON.stringify(result).includes(GLOBAL_API_KEY), false);
});

test("uses an empty selection input and forwards omitted runtime options unchanged", async () => {
  const db = {} as any;
  const selection = selectionResult([]);
  const selectionCalls: any[] = [];
  const batchCalls: any[] = [];

  const result = await runChannexAriDispatchCycle({
    db,
    readSelection: (async (receivedDb: any, input: any) => {
      selectionCalls.push({ receivedDb, input });
      return selection as any;
    }) as any,
    runBatch: (async (input: any) => {
      batchCalls.push(input);
      return {
        selectedCount: 0,
        recoveredCount: 0,
        executedCount: 0,
        failedCount: 0,
        results: [],
      } as any;
    }) as any,
  });

  assert.deepEqual(selectionCalls, [
    {
      receivedDb: db,
      input: {},
    },
  ]);
  assert.deepEqual(batchCalls, [
    {
      db,
      actions: [],
      credentialsSecret: undefined,
      globalApiKey: undefined,
      baseUrl: undefined,
      timeoutMs: undefined,
      jitterMs: undefined,
      leaseMs: undefined,
      completionReserveMs: undefined,
      transport: undefined,
      clock: undefined,
      leaseTokenFactory: undefined,
    },
  ]);
  assert.equal(result.selection, selection);
  assert.equal(result.batch.selectedCount, 0);
});

test("rejects malformed selection contracts before running the batch", async () => {
  const invalidSelections: Array<{
    value: unknown;
    error: RegExp;
  }> = [
    {
      value: null,
      error: /CHANNEX_ARI_DISPATCH_CYCLE_SELECTION_INVALID/,
    },
    {
      value: [],
      error: /CHANNEX_ARI_DISPATCH_CYCLE_SELECTION_INVALID/,
    },
    {
      value: {},
      error: /CHANNEX_ARI_DISPATCH_CYCLE_ACTIONS_INVALID/,
    },
    {
      value: { actions: [], selectedCount: -1 },
      error: /CHANNEX_ARI_DISPATCH_CYCLE_SELECTED_COUNT_MISMATCH/,
    },
    {
      value: { actions: [], selectedCount: 0.5 },
      error: /CHANNEX_ARI_DISPATCH_CYCLE_SELECTED_COUNT_MISMATCH/,
    },
    {
      value: { actions: [selectedAction()], selectedCount: 0 },
      error: /CHANNEX_ARI_DISPATCH_CYCLE_SELECTED_COUNT_MISMATCH/,
    },
  ];

  for (const scenario of invalidSelections) {
    let batchCalls = 0;

    await assert.rejects(
      () =>
        runChannexAriDispatchCycle({
          db: {} as any,
          readSelection: (async () => scenario.value) as any,
          runBatch: (async () => {
            batchCalls += 1;
            return {} as any;
          }) as any,
        }),
      scenario.error
    );
    assert.equal(batchCalls, 0);
  }
});

test("propagates selection failure without running the batch", async () => {
  let selectionCalls = 0;
  let batchCalls = 0;

  await assert.rejects(
    () =>
      runChannexAriDispatchCycle({
        db: {} as any,
        readSelection: (async () => {
          selectionCalls += 1;
          throw new Error("SELECTION_FAILED");
        }) as any,
        runBatch: (async () => {
          batchCalls += 1;
          return {} as any;
        }) as any,
      }),
    /SELECTION_FAILED/
  );

  assert.equal(selectionCalls, 1);
  assert.equal(batchCalls, 0);
});

test("propagates batch failure without retrying the cycle", async () => {
  let selectionCalls = 0;
  let batchCalls = 0;
  const selection = selectionResult();

  await assert.rejects(
    () =>
      runChannexAriDispatchCycle({
        db: {} as any,
        readSelection: (async () => {
          selectionCalls += 1;
          return selection as any;
        }) as any,
        runBatch: (async () => {
          batchCalls += 1;
          throw new Error("BATCH_FAILED");
        }) as any,
      }),
    /BATCH_FAILED/
  );

  assert.equal(selectionCalls, 1);
  assert.equal(batchCalls, 1);
});

test("does not mutate the selection result or selected actions", async () => {
  const selected = selectedAction();
  const selection = selectionResult([selected]);
  const before = structuredClone(selection);

  const result = await runChannexAriDispatchCycle({
    db: {} as any,
    readSelection: (async () => selection as any) as any,
    runBatch: (async (input: any) => ({
      selectedCount: input.actions.length,
      recoveredCount: 0,
      executedCount: input.actions.length,
      failedCount: 0,
      results: [],
    })) as any,
  });

  assert.deepEqual(selection, before);
  assert.equal(result.selection, selection);
  assert.equal(result.selection.actions[0], selected);
});
