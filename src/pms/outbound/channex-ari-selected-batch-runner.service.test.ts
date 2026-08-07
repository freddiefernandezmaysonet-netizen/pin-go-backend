import assert from "node:assert/strict";
import test from "node:test";

import { CHANNEX_ARI_MAX_SELECTION_LIMIT } from "./channex-ari-job-selection.policy";
import { runSelectedChannexAriBatch } from "./channex-ari-selected-batch-runner.service";

const RECOVERED_AT = new Date("2026-07-28T12:00:00.000Z");
const CLAIMED_AT = new Date("2026-07-28T12:00:01.000Z");
const LEASE_EXPIRES_AT = new Date("2026-07-28T12:02:01.000Z");
const API_KEY = "secret-channex-api-key";
const CREDENTIALS_SECRET = "secret-pms-credentials-key";
const GLOBAL_API_KEY = "secret-global-channex-key";

function action(overrides: Record<string, unknown> = {}) {
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

function preflightRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "delivery-1",
    organizationId: "org-1",
    propertyId: "property-1",
    connectionId: "connection-1",
    messageKind: "AVAILABILITY" as const,
    status: "READY" as const,
    attemptCount: 0,
    leaseToken: null,
    leaseExpiresAt: null,
    ...overrides,
  };
}

function claimedDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: "delivery-1",
    organizationId: "org-1",
    propertyId: "property-1",
    connectionId: "connection-1",
    listingId: "listing-1",
    messageKind: "AVAILABILITY" as const,
    status: "PROCESSING" as const,
    payload: {
      values: [
        {
          property_id: "channex-property-1",
          room_type_id: "room-type-1",
          date: "2026-08-01",
          availability: 1,
        },
      ],
    },
    payloadHash:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    payloadValueCount: 1,
    payloadBytes: 156,
    attemptCount: 1,
    leaseToken: "lease-1",
    leaseExpiresAt: LEASE_EXPIRES_AT,
    ...overrides,
  };
}

function createClock(...dates: Date[]) {
  let index = 0;

  return () => {
    const value = dates[Math.min(index, dates.length - 1)];
    index += 1;
    return new Date(value);
  };
}

function createDb(rows: Record<string, any> = {}) {
  const calls: any[] = [];

  return {
    db: {
      channexAriDelivery: {
        findUnique: async (args: any) => {
          calls.push(args);
          const id = String(args?.where?.id ?? "");
          return rows[id] ? { ...rows[id] } : null;
        },
      },
    } as any,
    calls,
  };
}

test("runs stale recovery and claim execution serially with sanitized evidence", async () => {
  const recoverAction = action({
    action: "RECOVER_STALE_LEASE",
    deliveryId: "delivery-recover",
    propertyId: "property-recover",
    partitionKey: "property-recover:AVAILABILITY",
    attemptCount: 2,
  });
  const claimAction = action();
  const mock = createDb({
    "delivery-1": preflightRow(),
  });
  const order: string[] = [];
  const recoveryInputs: any[] = [];
  const credentialInputs: any[] = [];
  const claimInputs: any[] = [];
  const executeInputs: any[] = [];
  const transport = { marker: "transport" } as any;
  const credentialEvidence = {
    connectionId: "connection-1",
    organizationId: "org-1",
    source: "GLOBAL_MANAGED",
    connectionType: "WHITE_LABEL_GLOBAL",
    managedBy: "PinGo",
  };
  const recovery = { deliveryId: "delivery-recover", status: "RETRY_WAIT" };
  const execution = {
    delivery: { id: "delivery-1" },
    completion: { retryClass: "SUCCESS" },
  };

  const result = await runSelectedChannexAriBatch({
    db: mock.db,
    actions: [recoverAction, claimAction],
    credentialsSecret: CREDENTIALS_SECRET,
    globalApiKey: GLOBAL_API_KEY,
    baseUrl: "https://staging.example.test",
    timeoutMs: 15_000,
    jitterMs: 321,
    leaseMs: 120_000,
    completionReserveMs: 5_000,
    transport,
    clock: createClock(RECOVERED_AT, CLAIMED_AT),
    leaseTokenFactory: (selectedAction, index) => {
      assert.equal(selectedAction.deliveryId, claimAction.deliveryId);
      assert.equal(index, 1);
      return "lease-1";
    },
    recover: (async (db: any, input: any) => {
      order.push("recover");
      recoveryInputs.push({ db, input });
      return recovery as any;
    }) as any,
    resolveCredentials: (async (db: any, input: any) => {
      order.push("credentials");
      credentialInputs.push({ db, input });
      return {
        apiKey: API_KEY,
        evidence: credentialEvidence,
      } as any;
    }) as any,
    claim: (async (db: any, input: any) => {
      order.push("claim");
      claimInputs.push({ db, input });
      return {
        delivery: claimedDelivery(),
        attempt: { id: "attempt-1" },
      } as any;
    }) as any,
    execute: (async (input: any) => {
      order.push("execute");
      executeInputs.push(input);
      return execution as any;
    }) as any,
  });

  assert.deepEqual(order, ["recover", "credentials", "claim", "execute"]);
  assert.deepEqual(recoveryInputs, [
    {
      db: mock.db,
      input: {
        deliveryId: "delivery-recover",
        now: RECOVERED_AT,
        jitterMs: 321,
      },
    },
  ]);
  assert.deepEqual(mock.calls, [
    {
      where: { id: "delivery-1" },
      select: {
        id: true,
        organizationId: true,
        propertyId: true,
        connectionId: true,
        messageKind: true,
        status: true,
        attemptCount: true,
        leaseToken: true,
        leaseExpiresAt: true,
      },
    },
  ]);
  assert.deepEqual(credentialInputs, [
    {
      db: mock.db,
      input: {
        connectionId: "connection-1",
        organizationId: "org-1",
        credentialsSecret: CREDENTIALS_SECRET,
        globalApiKey: GLOBAL_API_KEY,
      },
    },
  ]);
  assert.deepEqual(claimInputs, [
    {
      db: mock.db,
      input: {
        deliveryId: "delivery-1",
        leaseToken: "lease-1",
        now: CLAIMED_AT,
        leaseMs: 120_000,
      },
    },
  ]);
  assert.deepEqual(executeInputs, [
    {
      db: mock.db,
      delivery: claimedDelivery(),
      apiKey: API_KEY,
      baseUrl: "https://staging.example.test",
      timeoutMs: 15_000,
      jitterMs: 321,
      completionReserveMs: 5_000,
      transport,
      clock: executeInputs[0].clock,
    },
  ]);
  assert.equal(typeof executeInputs[0].clock, "function");
  assert.deepEqual(result, {
    selectedCount: 2,
    recoveredCount: 1,
    executedCount: 1,
    failedCount: 0,
    results: [
      {
        action: recoverAction,
        outcome: "RECOVERED",
        recoveredAt: RECOVERED_AT,
        recovery,
      },
      {
        action: claimAction,
        outcome: "EXECUTED",
        claimedAt: CLAIMED_AT,
        credentials: credentialEvidence,
        execution,
      },
    ],
  });
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
  assert.equal(JSON.stringify(result).includes(CREDENTIALS_SECRET), false);
  assert.equal(JSON.stringify(result).includes(GLOBAL_API_KEY), false);
});

test("resolves credentials before claiming and continues after preflight failure", async () => {
  const first = action({ deliveryId: "delivery-bad" });
  const second = action({
    deliveryId: "delivery-good",
    propertyId: "property-2",
    partitionKey: "property-2:AVAILABILITY",
  });
  const mock = createDb({
    "delivery-bad": preflightRow({
      id: "delivery-bad",
      organizationId: "wrong-org",
    }),
    "delivery-good": preflightRow({
      id: "delivery-good",
      propertyId: "property-2",
      connectionId: "connection-2",
    }),
  });
  const credentialCalls: string[] = [];
  const claimCalls: string[] = [];
  const executeCalls: string[] = [];

  const result = await runSelectedChannexAriBatch({
    db: mock.db,
    actions: [first, second],
    clock: createClock(CLAIMED_AT),
    leaseTokenFactory: (selectedAction) => `lease-${selectedAction.deliveryId}`,
    resolveCredentials: (async (_db: any, input: any) => {
      credentialCalls.push(input.connectionId);
      return {
        apiKey: API_KEY,
        evidence: {
          connectionId: input.connectionId,
          organizationId: input.organizationId,
          source: "GLOBAL_MANAGED",
          connectionType: "WHITE_LABEL_GLOBAL",
          managedBy: "PinGo",
        },
      } as any;
    }) as any,
    claim: (async (_db: any, input: any) => {
      claimCalls.push(input.deliveryId);
      return {
        delivery: claimedDelivery({
          id: "delivery-good",
          propertyId: "property-2",
          connectionId: "connection-2",
          leaseToken: "lease-delivery-good",
        }),
      } as any;
    }) as any,
    execute: (async (input: any) => {
      executeCalls.push(input.delivery.id);
      return { ok: true } as any;
    }) as any,
  });

  assert.deepEqual(credentialCalls, ["connection-2"]);
  assert.deepEqual(claimCalls, ["delivery-good"]);
  assert.deepEqual(executeCalls, ["delivery-good"]);
  assert.equal(result.executedCount, 1);
  assert.equal(result.failedCount, 1);
  assert.deepEqual(result.results[0], {
    action: first,
    outcome: "FAILED",
    failure: {
      phase: "PREFLIGHT",
      errorCode: "CHANNEX_ARI_BATCH_ORGANIZATION_MISMATCH",
      claimed: false,
    },
  });
});

test("credential failure happens before claim and does not block the next action", async () => {
  const first = action({ deliveryId: "delivery-1" });
  const second = action({
    deliveryId: "delivery-2",
    propertyId: "property-2",
    partitionKey: "property-2:AVAILABILITY",
  });
  const mock = createDb({
    "delivery-1": preflightRow(),
    "delivery-2": preflightRow({
      id: "delivery-2",
      propertyId: "property-2",
      connectionId: "connection-2",
    }),
  });
  const claimCalls: string[] = [];

  const result = await runSelectedChannexAriBatch({
    db: mock.db,
    actions: [first, second],
    clock: createClock(CLAIMED_AT),
    leaseTokenFactory: (selectedAction) => `lease-${selectedAction.deliveryId}`,
    resolveCredentials: (async (_db: any, input: any) => {
      if (input.connectionId === "connection-1") {
        throw new Error("CHANNEX_ARI_CREDENTIAL_API_KEY_MISSING");
      }

      return {
        apiKey: API_KEY,
        evidence: {
          connectionId: "connection-2",
          organizationId: "org-1",
          source: "GLOBAL_MANAGED",
          connectionType: "WHITE_LABEL_GLOBAL",
          managedBy: "PinGo",
        },
      } as any;
    }) as any,
    claim: (async (_db: any, input: any) => {
      claimCalls.push(input.deliveryId);
      return {
        delivery: claimedDelivery({
          id: "delivery-2",
          propertyId: "property-2",
          connectionId: "connection-2",
          leaseToken: "lease-delivery-2",
        }),
      } as any;
    }) as any,
    execute: (async () => ({ ok: true })) as any,
  });

  assert.deepEqual(claimCalls, ["delivery-2"]);
  assert.deepEqual(result.results[0], {
    action: first,
    outcome: "FAILED",
    failure: {
      phase: "PREFLIGHT",
      errorCode: "CHANNEX_ARI_CREDENTIAL_API_KEY_MISSING",
      claimed: false,
    },
  });
  assert.equal(result.executedCount, 1);
  assert.equal(result.failedCount, 1);
});

test("isolates recovery, claim and execution failures by phase", async () => {
  const recoverAction = action({
    action: "RECOVER_STALE_LEASE",
    deliveryId: "delivery-recover",
    propertyId: "property-recover",
    partitionKey: "property-recover:AVAILABILITY",
  });
  const claimFailureAction = action({
    deliveryId: "delivery-claim",
    propertyId: "property-claim",
    partitionKey: "property-claim:AVAILABILITY",
  });
  const executeFailureAction = action({
    deliveryId: "delivery-execute",
    propertyId: "property-execute",
    partitionKey: "property-execute:AVAILABILITY",
  });
  const mock = createDb({
    "delivery-claim": preflightRow({
      id: "delivery-claim",
      propertyId: "property-claim",
      connectionId: "connection-claim",
    }),
    "delivery-execute": preflightRow({
      id: "delivery-execute",
      propertyId: "property-execute",
      connectionId: "connection-execute",
    }),
  });

  const result = await runSelectedChannexAriBatch({
    db: mock.db,
    actions: [recoverAction, claimFailureAction, executeFailureAction],
    clock: createClock(RECOVERED_AT, CLAIMED_AT, CLAIMED_AT),
    leaseTokenFactory: (selectedAction) => `lease-${selectedAction.deliveryId}`,
    recover: (async () => {
      throw new Error("RECOVERY_FAILED");
    }) as any,
    resolveCredentials: (async (_db: any, input: any) => ({
      apiKey: API_KEY,
      evidence: {
        connectionId: input.connectionId,
        organizationId: input.organizationId,
        source: "GLOBAL_MANAGED",
        connectionType: "WHITE_LABEL_GLOBAL",
        managedBy: "PinGo",
      },
    })) as any,
    claim: (async (_db: any, input: any) => {
      if (input.deliveryId === "delivery-claim") {
        throw new Error("CLAIM_FAILED");
      }

      return {
        delivery: claimedDelivery({
          id: "delivery-execute",
          propertyId: "property-execute",
          connectionId: "connection-execute",
          leaseToken: "lease-delivery-execute",
        }),
      } as any;
    }) as any,
    execute: (async () => {
      throw new Error("EXECUTION_FAILED");
    }) as any,
  });

  assert.equal(result.executedCount, 0);
  assert.equal(result.recoveredCount, 0);
  assert.equal(result.failedCount, 3);
  assert.deepEqual(result.results[0], {
    action: recoverAction,
    outcome: "FAILED",
    failure: {
      phase: "RECOVER_STALE_LEASE",
      errorCode: "RECOVERY_FAILED",
      claimed: false,
    },
  });
  assert.deepEqual(result.results[1], {
    action: claimFailureAction,
    outcome: "FAILED",
    failure: {
      phase: "CLAIM",
      errorCode: "CLAIM_FAILED",
      claimed: false,
    },
  });
  assert.deepEqual(result.results[2], {
    action: executeFailureAction,
    outcome: "FAILED",
    failure: {
      phase: "EXECUTE",
      errorCode: "EXECUTION_FAILED",
      claimed: true,
      attemptCount: 1,
      leaseExpiresAt: LEASE_EXPIRES_AT,
    },
  });
});

test("rejects a claim result that no longer matches preflight", async () => {
  const selectedAction = action();
  const mock = createDb({
    "delivery-1": preflightRow(),
  });
  let executeCalls = 0;

  const result = await runSelectedChannexAriBatch({
    db: mock.db,
    actions: [selectedAction],
    clock: createClock(CLAIMED_AT),
    leaseTokenFactory: () => "lease-1",
    resolveCredentials: (async () => ({
      apiKey: API_KEY,
      evidence: {},
    })) as any,
    claim: (async () => ({
      delivery: claimedDelivery({ organizationId: "org-2" }),
    })) as any,
    execute: (async () => {
      executeCalls += 1;
      return {} as any;
    }) as any,
  });

  assert.equal(executeCalls, 0);
  assert.deepEqual(result.results[0], {
    action: selectedAction,
    outcome: "FAILED",
    failure: {
      phase: "CLAIM",
      errorCode: "CHANNEX_ARI_BATCH_CLAIM_RESULT_MISMATCH",
      claimed: true,
      attemptCount: 1,
      leaseExpiresAt: LEASE_EXPIRES_AT,
    },
  });
});

test("sanitizes non-public thrown messages", async () => {
  const selectedAction = action();
  const mock = createDb({
    "delivery-1": preflightRow(),
  });

  const result = await runSelectedChannexAriBatch({
    db: mock.db,
    actions: [selectedAction],
    resolveCredentials: (async () => {
      throw new Error("credential failed: apiKey=super-secret");
    }) as any,
  });

  assert.deepEqual(result.results[0], {
    action: selectedAction,
    outcome: "FAILED",
    failure: {
      phase: "PREFLIGHT",
      errorCode: "CHANNEX_ARI_BATCH_ACTION_FAILED",
      claimed: false,
    },
  });
  assert.equal(JSON.stringify(result).includes("super-secret"), false);
});

test("returns an empty deterministic result for an empty selection", async () => {
  const mock = createDb();

  const result = await runSelectedChannexAriBatch({
    db: mock.db,
    actions: [],
  });

  assert.deepEqual(result, {
    selectedCount: 0,
    recoveredCount: 0,
    executedCount: 0,
    failedCount: 0,
    results: [],
  });
  assert.equal(mock.calls.length, 0);
});

test("validates the selected batch before any database access", async () => {
  const valid = action();
  const invalidBatches: Array<{
    actions: any;
    error: RegExp;
  }> = [
    {
      actions: null,
      error: /CHANNEX_ARI_BATCH_ACTIONS_REQUIRED/,
    },
    {
      actions: Array.from(
        { length: CHANNEX_ARI_MAX_SELECTION_LIMIT + 1 },
        (_, index) =>
          action({
            deliveryId: `delivery-${index}`,
            propertyId: `property-${index}`,
            partitionKey: `property-${index}:AVAILABILITY`,
          })
      ),
      error: /CHANNEX_ARI_BATCH_ACTION_LIMIT_EXCEEDED/,
    },
    {
      actions: [{ ...valid, deliveryId: " " }],
      error: /CHANNEX_ARI_BATCH_ACTION_0_DELIVERY_ID_REQUIRED/,
    },
    {
      actions: [{ ...valid, messageKind: "INVALID" }],
      error: /CHANNEX_ARI_BATCH_ACTION_0_MESSAGE_KIND_INVALID/,
    },
    {
      actions: [{ ...valid, action: "INVALID" }],
      error: /CHANNEX_ARI_BATCH_ACTION_0_KIND_INVALID/,
    },
    {
      actions: [{ ...valid, attemptCount: -1 }],
      error: /CHANNEX_ARI_BATCH_ACTION_0_ATTEMPT_COUNT_INVALID/,
    },
    {
      actions: [{ ...valid, partitionKey: "wrong" }],
      error: /CHANNEX_ARI_BATCH_ACTION_0_PARTITION_MISMATCH/,
    },
    {
      actions: [{ ...valid, readyAt: new Date("invalid") }],
      error: /CHANNEX_ARI_BATCH_ACTION_0_READY_AT_INVALID/,
    },
    {
      actions: [valid, { ...valid }],
      error: /CHANNEX_ARI_BATCH_DUPLICATE_DELIVERY_ID/,
    },
    {
      actions: [
        valid,
        {
          ...valid,
          deliveryId: "delivery-2",
        },
      ],
      error: /CHANNEX_ARI_BATCH_DUPLICATE_PARTITION/,
    },
  ];

  for (const scenario of invalidBatches) {
    const mock = createDb();

    await assert.rejects(
      () =>
        runSelectedChannexAriBatch({
          db: mock.db,
          actions: scenario.actions,
        }),
      scenario.error
    );
    assert.equal(mock.calls.length, 0);
  }
});

test("does not mutate selected actions", async () => {
  const selectedAction = action();
  const before = structuredClone(selectedAction);
  const mock = createDb({
    "delivery-1": preflightRow(),
  });

  await runSelectedChannexAriBatch({
    db: mock.db,
    actions: [selectedAction],
    clock: createClock(CLAIMED_AT),
    leaseTokenFactory: () => "lease-1",
    resolveCredentials: (async () => ({
      apiKey: API_KEY,
      evidence: {},
    })) as any,
    claim: (async () => ({
      delivery: claimedDelivery(),
    })) as any,
    execute: (async () => ({ ok: true })) as any,
  });

  assert.deepEqual(selectedAction, before);
});
