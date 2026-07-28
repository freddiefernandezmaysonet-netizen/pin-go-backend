import assert from "node:assert/strict";
import test from "node:test";

import { completeChannexAriDeliveryAttempt } from "./channex-ari-attempt-completion.service";
import { CHANNEX_ARI_MAX_ATTEMPTS } from "./channex-ari-lifecycle.policy";

const STARTED_AT = new Date("2026-07-28T12:00:00.000Z");
const COMPLETED_AT = new Date("2026-07-28T12:00:02.500Z");
const LEASE_EXPIRES_AT = new Date("2026-07-28T12:02:00.000Z");

type DeliveryRow = {
  id: string;
  organizationId: string;
  propertyId: string;
  messageKind: "AVAILABILITY" | "RATES_RESTRICTIONS";
  syncMode: "INCREMENTAL" | "FULL";
  status: "READY" | "PROCESSING" | "RETRY_WAIT" | "SENT" | "DEAD";
  attemptCount: number;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
};

type AttemptRow = {
  id: string;
  attemptNumber: number;
  outcome:
    | "IN_FLIGHT"
    | "SUCCESS"
    | "RETRYABLE_FAILURE"
    | "TERMINAL_FAILURE"
    | "UNKNOWN_AFTER_LEASE";
  startedAt: Date;
  completedAt: Date | null;
};

type PropertyStateRow = {
  organizationId: string;
  pausedUntil: Date | null;
};

function processingDelivery(overrides: Partial<DeliveryRow> = {}): DeliveryRow {
  return {
    id: "delivery-1",
    organizationId: "org-1",
    propertyId: "property-1",
    messageKind: "AVAILABILITY",
    syncMode: "INCREMENTAL",
    status: "PROCESSING",
    attemptCount: 1,
    leaseToken: "lease-1",
    leaseExpiresAt: LEASE_EXPIRES_AT,
    ...overrides,
  };
}

function inFlightAttempt(overrides: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id: "attempt-1",
    attemptNumber: 1,
    outcome: "IN_FLIGHT",
    startedAt: STARTED_AT,
    completedAt: null,
    ...overrides,
  };
}

function propertyState(
  overrides: Partial<PropertyStateRow> = {}
): PropertyStateRow {
  return {
    organizationId: "org-1",
    pausedUntil: null,
    ...overrides,
  };
}

function createMockDb(input: {
  delivery?: DeliveryRow | null;
  attempt?: AttemptRow | null;
  propertyState?: PropertyStateRow | null;
  deliveryUpdateCount?: number;
  attemptUpdateCount?: number;
}) {
  const state = {
    isolationLevel: null as string | null,
    deliveryFindArgs: [] as any[],
    deliveryUpdateArgs: [] as any[],
    attemptFindArgs: [] as any[],
    attemptUpdateArgs: [] as any[],
    propertyFindArgs: [] as any[],
    propertyUpsertArgs: [] as any[],
  };

  const tx = {
    channexAriDelivery: {
      findUnique: async (args: any) => {
        state.deliveryFindArgs.push(args);
        const row = input.delivery === undefined ? processingDelivery() : input.delivery;
        return row ? { ...row } : null;
      },
      updateMany: async (args: any) => {
        state.deliveryUpdateArgs.push(args);
        return { count: input.deliveryUpdateCount ?? 1 };
      },
    },
    channexAriDeliveryAttempt: {
      findUnique: async (args: any) => {
        state.attemptFindArgs.push(args);
        const row = input.attempt === undefined ? inFlightAttempt() : input.attempt;
        return row ? { ...row } : null;
      },
      updateMany: async (args: any) => {
        state.attemptUpdateArgs.push(args);
        return { count: input.attemptUpdateCount ?? 1 };
      },
    },
    channexAriPropertyState: {
      findUnique: async (args: any) => {
        state.propertyFindArgs.push(args);
        const row =
          input.propertyState === undefined
            ? propertyState()
            : input.propertyState;
        return row ? { ...row } : null;
      },
      upsert: async (args: any) => {
        state.propertyUpsertArgs.push(args);
        return {
          propertyId: args.create.propertyId,
          organizationId: args.create.organizationId,
          ...args.update,
        };
      },
    },
  };

  return {
    db: {
      $transaction: async (
        callback: (transaction: any) => Promise<any>,
        options?: { isolationLevel?: string }
      ) => {
        state.isolationLevel = options?.isolationLevel ?? null;
        return callback(tx);
      },
    },
    state,
  };
}

test("persists a successful attempt and Availability success timestamp atomically", async () => {
  const mock = createMockDb({});

  const result = await completeChannexAriDeliveryAttempt(mock.db as any, {
    deliveryId: " delivery-1 ",
    leaseToken: " lease-1 ",
    evidence: {
      httpStatus: 200,
      taskId: "task-123",
      responseMeta: { requestId: "req-1" },
    },
    completedAt: COMPLETED_AT,
  });

  assert.equal(mock.state.isolationLevel, "Serializable");
  assert.deepEqual(mock.state.deliveryFindArgs, [
    {
      where: { id: "delivery-1" },
      select: {
        id: true,
        organizationId: true,
        propertyId: true,
        messageKind: true,
        syncMode: true,
        status: true,
        attemptCount: true,
        leaseToken: true,
        leaseExpiresAt: true,
      },
    },
  ]);
  assert.deepEqual(mock.state.propertyFindArgs, [
    {
      where: { propertyId: "property-1" },
      select: {
        organizationId: true,
        pausedUntil: true,
      },
    },
  ]);
  assert.deepEqual(mock.state.attemptFindArgs, [
    {
      where: {
        deliveryId_attemptNumber: {
          deliveryId: "delivery-1",
          attemptNumber: 1,
        },
      },
      select: {
        id: true,
        attemptNumber: true,
        outcome: true,
        startedAt: true,
        completedAt: true,
      },
    },
  ]);

  assert.deepEqual(mock.state.deliveryUpdateArgs[0].where, {
    id: "delivery-1",
    status: "PROCESSING",
    attemptCount: 1,
    leaseToken: "lease-1",
    leaseExpiresAt: LEASE_EXPIRES_AT,
  });
  assert.deepEqual(mock.state.deliveryUpdateArgs[0].data, {
    status: "SENT",
    nextAttemptAt: null,
    leaseToken: null,
    leaseExpiresAt: null,
    channexTaskId: "task-123",
    httpStatus: 200,
    warningCount: 0,
    lastErrorCode: null,
    lastErrorSummary: null,
    sentAt: COMPLETED_AT,
  });

  assert.deepEqual(mock.state.attemptUpdateArgs[0].where, {
    id: "attempt-1",
    deliveryId: "delivery-1",
    attemptNumber: 1,
    outcome: "IN_FLIGHT",
    completedAt: null,
  });
  assert.deepEqual(mock.state.attemptUpdateArgs[0].data, {
    outcome: "SUCCESS",
    completedAt: COMPLETED_AT,
    durationMs: 2_500,
    httpStatus: 200,
    channexTaskId: "task-123",
    warningCount: 0,
    retryAfterMs: null,
    errorCode: null,
    responseMeta: {
      requestId: "req-1",
      retryClass: "SUCCESS",
      networkError: false,
      timedOut: false,
      leaseExpiresAt: LEASE_EXPIRES_AT.toISOString(),
    },
  });
  assert.deepEqual(mock.state.propertyUpsertArgs, [
    {
      where: { propertyId: "property-1" },
      create: {
        propertyId: "property-1",
        organizationId: "org-1",
        lastSuccessfulAvailabilityAt: COMPLETED_AT,
      },
      update: {
        lastSuccessfulAvailabilityAt: COMPLETED_AT,
      },
    },
  ]);

  assert.equal(result.retryClass, "SUCCESS");
  assert.equal(result.deliveryUpdate.status, "SENT");
  assert.equal(result.attemptUpdate.outcome, "SUCCESS");
});

test("persists a Rates Full Sync success with both durable timestamps", async () => {
  const mock = createMockDb({
    delivery: processingDelivery({
      messageKind: "RATES_RESTRICTIONS",
      syncMode: "FULL",
    }),
  });

  const result = await completeChannexAriDeliveryAttempt(mock.db as any, {
    deliveryId: "delivery-1",
    leaseToken: "lease-1",
    evidence: {
      httpStatus: 202,
      taskId: "task-full",
    },
    completedAt: COMPLETED_AT,
  });

  assert.deepEqual(result.propertyStateUpdate, {
    lastSuccessfulRatesAt: COMPLETED_AT,
    lastFullSyncCompletedAt: COMPLETED_AT,
  });
  assert.deepEqual(mock.state.propertyUpsertArgs[0].update, {
    lastSuccessfulRatesAt: COMPLETED_AT,
    lastFullSyncCompletedAt: COMPLETED_AT,
  });
});

test("persists a retryable 429 with Retry-After and rate-limit evidence", async () => {
  const existingPause = new Date("2026-07-28T12:10:00.000Z");
  const mock = createMockDb({
    delivery: processingDelivery({ attemptCount: 2 }),
    attempt: inFlightAttempt({ id: "attempt-2", attemptNumber: 2 }),
    propertyState: propertyState({ pausedUntil: existingPause }),
  });

  const result = await completeChannexAriDeliveryAttempt(mock.db as any, {
    deliveryId: "delivery-1",
    leaseToken: "lease-1",
    evidence: {
      httpStatus: 429,
      retryAfterMs: 180_000,
    },
    completedAt: COMPLETED_AT,
    jitterMs: 1_000,
  });

  assert.equal(result.retryClass, "RETRYABLE");
  assert.equal(result.exhausted, false);
  assert.equal(result.retryDelayMs, 181_000);
  assert.equal(result.deliveryUpdate.status, "RETRY_WAIT");
  assert.deepEqual(result.propertyStateUpdate, {
    pausedUntil: existingPause,
    lastRateLimitAt: COMPLETED_AT,
  });
  assert.deepEqual(mock.state.propertyUpsertArgs[0].update, {
    pausedUntil: existingPause,
    lastRateLimitAt: COMPLETED_AT,
  });
});

test("persists a terminal response as DEAD without touching property state", async () => {
  const mock = createMockDb({});

  const result = await completeChannexAriDeliveryAttempt(mock.db as any, {
    deliveryId: "delivery-1",
    leaseToken: "lease-1",
    evidence: {
      httpStatus: 401,
      errorCode: "CHANNEX_AUTH_REJECTED",
      errorSummary: "The Channex credential was rejected.",
    },
    completedAt: COMPLETED_AT,
  });

  assert.equal(result.retryClass, "TERMINAL");
  assert.equal(result.deliveryUpdate.status, "DEAD");
  assert.equal(result.attemptUpdate.outcome, "TERMINAL_FAILURE");
  assert.deepEqual(result.propertyStateUpdate, {});
  assert.equal(mock.state.propertyUpsertArgs.length, 0);
});

test("persists a retryable final attempt as DEAD while retaining retry evidence", async () => {
  const mock = createMockDb({
    delivery: processingDelivery({ attemptCount: CHANNEX_ARI_MAX_ATTEMPTS }),
    attempt: inFlightAttempt({
      id: "attempt-final",
      attemptNumber: CHANNEX_ARI_MAX_ATTEMPTS,
    }),
  });

  const result = await completeChannexAriDeliveryAttempt(mock.db as any, {
    deliveryId: "delivery-1",
    leaseToken: "lease-1",
    evidence: { httpStatus: 503 },
    completedAt: COMPLETED_AT,
  });

  assert.equal(result.retryClass, "RETRYABLE");
  assert.equal(result.exhausted, true);
  assert.equal(result.deliveryUpdate.status, "DEAD");
  assert.equal(result.attemptUpdate.outcome, "RETRYABLE_FAILURE");
  assert.ok(result.retryDelayMs != null);
});

test("rejects a missing, non-processing or lease-less delivery before mutation", async () => {
  const missing = createMockDb({ delivery: null });
  await assert.rejects(
    () =>
      completeChannexAriDeliveryAttempt(missing.db as any, {
        deliveryId: "missing",
        leaseToken: "lease-1",
        evidence: { httpStatus: 200, taskId: "task-1" },
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_DELIVERY_NOT_FOUND/
  );

  const ready = createMockDb({
    delivery: processingDelivery({ status: "READY" }),
  });
  await assert.rejects(
    () =>
      completeChannexAriDeliveryAttempt(ready.db as any, {
        deliveryId: "delivery-1",
        leaseToken: "lease-1",
        evidence: { httpStatus: 200, taskId: "task-1" },
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_PROCESSING_REQUIRED/
  );

  const leaseLess = createMockDb({
    delivery: processingDelivery({ leaseExpiresAt: null }),
  });
  await assert.rejects(
    () =>
      completeChannexAriDeliveryAttempt(leaseLess.db as any, {
        deliveryId: "delivery-1",
        leaseToken: "lease-1",
        evidence: { httpStatus: 200, taskId: "task-1" },
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_LEASE_EXPIRES_AT_REQUIRED/
  );

  for (const mock of [missing, ready, leaseLess]) {
    assert.equal(mock.state.deliveryUpdateArgs.length, 0);
    assert.equal(mock.state.attemptUpdateArgs.length, 0);
    assert.equal(mock.state.propertyUpsertArgs.length, 0);
  }
});

test("rejects completion at or after lease expiry", async () => {
  for (const completedAt of [
    LEASE_EXPIRES_AT,
    new Date(LEASE_EXPIRES_AT.getTime() + 1),
  ]) {
    const mock = createMockDb({});

    await assert.rejects(
      () =>
        completeChannexAriDeliveryAttempt(mock.db as any, {
          deliveryId: "delivery-1",
          leaseToken: "lease-1",
          evidence: { httpStatus: 200, taskId: "task-1" },
          completedAt,
        }),
      /CHANNEX_ARI_COMPLETION_LEASE_EXPIRED/
    );
    assert.equal(mock.state.propertyFindArgs.length, 0);
    assert.equal(mock.state.attemptFindArgs.length, 0);
  }
});

test("rejects cross-tenant property state before reading attempt evidence", async () => {
  const mock = createMockDb({
    propertyState: propertyState({ organizationId: "org-2" }),
  });

  await assert.rejects(
    () =>
      completeChannexAriDeliveryAttempt(mock.db as any, {
        deliveryId: "delivery-1",
        leaseToken: "lease-1",
        evidence: { httpStatus: 200, taskId: "task-1" },
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_PROPERTY_STATE_TENANT_MISMATCH/
  );

  assert.equal(mock.state.attemptFindArgs.length, 0);
  assert.equal(mock.state.deliveryUpdateArgs.length, 0);
});

test("rejects missing attempt evidence before mutation", async () => {
  const mock = createMockDb({ attempt: null });

  await assert.rejects(
    () =>
      completeChannexAriDeliveryAttempt(mock.db as any, {
        deliveryId: "delivery-1",
        leaseToken: "lease-1",
        evidence: { httpStatus: 200, taskId: "task-1" },
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_ATTEMPT_EVIDENCE_MISSING/
  );

  assert.equal(mock.state.deliveryUpdateArgs.length, 0);
  assert.equal(mock.state.attemptUpdateArgs.length, 0);
});

test("rejects a stale worker lease token before database updates", async () => {
  const mock = createMockDb({});

  await assert.rejects(
    () =>
      completeChannexAriDeliveryAttempt(mock.db as any, {
        deliveryId: "delivery-1",
        leaseToken: "old-lease",
        evidence: { httpStatus: 200, taskId: "task-1" },
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_LEASE_TOKEN_MISMATCH/
  );

  assert.equal(mock.state.deliveryUpdateArgs.length, 0);
  assert.equal(mock.state.attemptUpdateArgs.length, 0);
});

test("detects a delivery fencing race before updating attempt evidence", async () => {
  const mock = createMockDb({ deliveryUpdateCount: 0 });

  await assert.rejects(
    () =>
      completeChannexAriDeliveryAttempt(mock.db as any, {
        deliveryId: "delivery-1",
        leaseToken: "lease-1",
        evidence: { httpStatus: 200, taskId: "task-1" },
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_DELIVERY_RACE/
  );

  assert.equal(mock.state.deliveryUpdateArgs.length, 1);
  assert.equal(mock.state.attemptUpdateArgs.length, 0);
  assert.equal(mock.state.propertyUpsertArgs.length, 0);
});

test("detects an attempt fencing race before updating property state", async () => {
  const mock = createMockDb({ attemptUpdateCount: 0 });

  await assert.rejects(
    () =>
      completeChannexAriDeliveryAttempt(mock.db as any, {
        deliveryId: "delivery-1",
        leaseToken: "lease-1",
        evidence: { httpStatus: 200, taskId: "task-1" },
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_ATTEMPT_RACE/
  );

  assert.equal(mock.state.deliveryUpdateArgs.length, 1);
  assert.equal(mock.state.attemptUpdateArgs.length, 1);
  assert.equal(mock.state.propertyUpsertArgs.length, 0);
});

test("validates required identifiers and completion timestamp before opening a transaction", async () => {
  for (const input of [
    {
      deliveryId: " ",
      leaseToken: "lease-1",
      completedAt: COMPLETED_AT,
      error: /CHANNEX_ARI_COMPLETION_DELIVERY_ID_REQUIRED/,
    },
    {
      deliveryId: "delivery-1",
      leaseToken: " ",
      completedAt: COMPLETED_AT,
      error: /CHANNEX_ARI_COMPLETION_LEASE_TOKEN_REQUIRED/,
    },
    {
      deliveryId: "delivery-1",
      leaseToken: "lease-1",
      completedAt: new Date("invalid"),
      error: /CHANNEX_ARI_COMPLETION_COMPLETED_AT_INVALID/,
    },
  ]) {
    const mock = createMockDb({});
    let transactionOpened = false;
    const db = {
      $transaction: async () => {
        transactionOpened = true;
        throw new Error("unexpected transaction");
      },
    };

    await assert.rejects(
      () =>
        completeChannexAriDeliveryAttempt(db as any, {
          deliveryId: input.deliveryId,
          leaseToken: input.leaseToken,
          evidence: { httpStatus: 200, taskId: "task-1" },
          completedAt: input.completedAt,
        }),
      input.error
    );
    assert.equal(transactionOpened, false);
    assert.equal(mock.state.deliveryUpdateArgs.length, 0);
  }
});
