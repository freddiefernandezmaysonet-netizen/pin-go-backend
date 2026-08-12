import assert from "node:assert/strict";
import test from "node:test";

import { CHANNEX_ARI_MAX_ATTEMPTS } from "./channex-ari-lifecycle.policy";
import {
  claimChannexAriDelivery,
  recoverStaleChannexAriDeliveryLease,
} from "./channex-ari-dispatch.service";

const NOW = new Date("2026-07-28T12:00:00.000Z");
const LEASE_EXPIRED_AT = new Date("2026-07-28T11:59:59.000Z");

type DeliveryRow = {
  id: string;
  organizationId: string;
  propertyId: string;
  connectionId: string;
  listingId: string;
  messageKind: "AVAILABILITY" | "RATES_RESTRICTIONS";
  status: "READY" | "PROCESSING" | "RETRY_WAIT" | "SENT" | "DEAD" | "SUPERSEDED";
  payload: unknown;
  payloadHash: string;
  payloadValueCount: number;
  payloadBytes: number;
  attemptCount: number;
  nextAttemptAt: Date | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
};

type AttemptRow = {
  id: string;
  deliveryId: string;
  attemptNumber: number;
  outcome:
    | "IN_FLIGHT"
    | "SUCCESS"
    | "RETRYABLE_FAILURE"
    | "TERMINAL_FAILURE"
    | "UNKNOWN_AFTER_LEASE";
  startedAt: Date;
  completedAt: Date | null;
  durationMs?: number | null;
  errorCode?: string | null;
};

type PropertyStateRow = {
  propertyId: string;
  organizationId: string;
  pausedUntil: Date | null;
  availabilityNextAllowedAt: Date | null;
  ratesNextAllowedAt: Date | null;
};

function readyDelivery(
  overrides: Partial<DeliveryRow> = {}
): DeliveryRow {
  return {
    id: "delivery-1",
    organizationId: "org-1",
    propertyId: "property-1",
    connectionId: "connection-1",
    listingId: "listing-1",
    messageKind: "AVAILABILITY",
    status: "READY",
    payload: {
      values: [
        {
          property_id: "channex-property-1",
          room_type_id: "room-1",
          date: "2026-08-01",
          availability: 1,
        },
      ],
    },
    payloadHash: "hash-1",
    payloadValueCount: 1,
    payloadBytes: 128,
    attemptCount: 0,
    nextAttemptAt: NOW,
    leaseToken: null,
    leaseExpiresAt: null,
    ...overrides,
  };
}

function inFlightAttempt(
  overrides: Partial<AttemptRow> = {}
): AttemptRow {
  return {
    id: "attempt-2",
    deliveryId: "delivery-1",
    attemptNumber: 2,
    outcome: "IN_FLIGHT",
    startedAt: new Date("2026-07-28T11:57:00.000Z"),
    completedAt: null,
    durationMs: null,
    errorCode: null,
    ...overrides,
  };
}

function propertyState(
  overrides: Partial<PropertyStateRow> = {}
): PropertyStateRow {
  return {
    propertyId: "property-1",
    organizationId: "org-1",
    pausedUntil: null,
    availabilityNextAllowedAt: null,
    ratesNextAllowedAt: null,
    ...overrides,
  };
}

function createMockDb(input: {
  delivery?: DeliveryRow | null;
  attempt?: AttemptRow | null;
  propertyState?: PropertyStateRow | null;
  claimCount?: number;
  recoveryDeliveryCount?: number;
  recoveryAttemptCount?: number;
}) {
  const state = {
    delivery: input.delivery === undefined ? readyDelivery() : input.delivery,
    attempt: input.attempt === undefined ? null : input.attempt,
    propertyState:
      input.propertyState === undefined ? null : input.propertyState,
    isolationLevel: null as string | null,
    deliveryFindArgs: [] as any[],
    deliveryUpdateArgs: [] as any[],
    attemptFindArgs: [] as any[],
    attemptCreateArgs: [] as any[],
    attemptUpdateArgs: [] as any[],
    propertyFindArgs: [] as any[],
    propertyUpsertArgs: [] as any[],
  };

  const tx = {
    channexAriDelivery: {
      findUnique: async (args: any) => {
        state.deliveryFindArgs.push(args);
        return state.delivery ? { ...state.delivery } : null;
      },
      updateMany: async (args: any) => {
        state.deliveryUpdateArgs.push(args);
        const count =
          args?.data?.status === "PROCESSING"
            ? input.claimCount ?? 1
            : input.recoveryDeliveryCount ?? 1;

        return { count };
      },
    },
    channexAriDeliveryAttempt: {
      findUnique: async (args: any) => {
        state.attemptFindArgs.push(args);
        return state.attempt ? { ...state.attempt } : null;
      },
      create: async (args: any) => {
        state.attemptCreateArgs.push(args);
        const created = {
          id: `attempt-${args.data.attemptNumber}`,
          completedAt: null,
          ...args.data,
        };
        return created;
      },
      updateMany: async (args: any) => {
        state.attemptUpdateArgs.push(args);
        return { count: input.recoveryAttemptCount ?? 1 };
      },
    },
    channexAriPropertyState: {
      findUnique: async (args: any) => {
        state.propertyFindArgs.push(args);
        return state.propertyState ? { ...state.propertyState } : null;
      },
      upsert: async (args: any) => {
        state.propertyUpsertArgs.push(args);
        return {
          ...(state.propertyState ?? {
            propertyId: args.create.propertyId,
            organizationId: args.create.organizationId,
            pausedUntil: null,
            availabilityNextAllowedAt: null,
            ratesNextAllowedAt: null,
          }),
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

test("claims one due delivery atomically with IN_FLIGHT evidence and durable throttle", async () => {
  const mock = createMockDb({
    delivery: readyDelivery(),
    propertyState: null,
  });

  const result = await claimChannexAriDelivery(mock.db as any, {
    deliveryId: " delivery-1 ",
    leaseToken: " lease-1 ",
    now: NOW,
  });

  assert.equal(mock.state.isolationLevel, "Serializable");
  assert.equal(mock.state.deliveryUpdateArgs.length, 1);
  assert.deepEqual(mock.state.deliveryUpdateArgs[0].where, {
    id: "delivery-1",
    status: "READY",
    attemptCount: 0,
    nextAttemptAt: NOW,
    leaseToken: null,
    leaseExpiresAt: null,
  });
  assert.deepEqual(mock.state.deliveryUpdateArgs[0].data, {
    status: "PROCESSING",
    attemptCount: 1,
    nextAttemptAt: null,
    leaseToken: "lease-1",
    leaseExpiresAt: new Date("2026-07-28T12:02:00.000Z"),
    processingStartedAt: NOW,
  });

  assert.deepEqual(mock.state.attemptCreateArgs, [
    {
      data: {
        deliveryId: "delivery-1",
        attemptNumber: 1,
        outcome: "IN_FLIGHT",
        startedAt: NOW,
      },
    },
  ]);
  assert.deepEqual(mock.state.propertyUpsertArgs, [
    {
      where: { propertyId: "property-1" },
      create: {
        propertyId: "property-1",
        organizationId: "org-1",
        availabilityNextAllowedAt: new Date("2026-07-28T12:00:06.500Z"),
      },
      update: {
        availabilityNextAllowedAt: new Date("2026-07-28T12:00:06.500Z"),
      },
    },
  ]);

  assert.equal(result.delivery.status, "PROCESSING");
  assert.equal(result.delivery.attemptCount, 1);
  assert.equal(result.delivery.leaseToken, "lease-1");
  assert.deepEqual(result.delivery.payload, readyDelivery().payload);
  assert.equal(result.attempt.outcome, "IN_FLIGHT");
});

test("claims Rates & Restrictions using only the rates throttle", async () => {
  const delivery = readyDelivery({
    messageKind: "RATES_RESTRICTIONS",
    status: "RETRY_WAIT",
    attemptCount: 2,
    nextAttemptAt: NOW,
  });
  const mock = createMockDb({
    delivery,
    propertyState: propertyState({
      availabilityNextAllowedAt: new Date("2026-07-28T13:00:00.000Z"),
    }),
  });

  const result = await claimChannexAriDelivery(mock.db as any, {
    deliveryId: "delivery-1",
    leaseToken: "lease-rates",
    now: NOW,
    leaseMs: 30_000,
  });

  assert.equal(result.delivery.attemptCount, 3);
  assert.deepEqual(mock.state.propertyUpsertArgs[0].update, {
    ratesNextAllowedAt: new Date("2026-07-28T12:00:06.500Z"),
  });
});

test("rejects claim when the durable property state belongs to another tenant", async () => {
  const mock = createMockDb({
    delivery: readyDelivery(),
    propertyState: propertyState({ organizationId: "org-2" }),
  });

  await assert.rejects(
    () =>
      claimChannexAriDelivery(mock.db as any, {
        deliveryId: "delivery-1",
        leaseToken: "lease-1",
        now: NOW,
      }),
    /CHANNEX_ARI_PROPERTY_STATE_TENANT_MISMATCH/
  );

  assert.equal(mock.state.deliveryUpdateArgs.length, 0);
  assert.equal(mock.state.attemptCreateArgs.length, 0);
  assert.equal(mock.state.propertyUpsertArgs.length, 0);
});

test("rejects a lost claim race before creating attempt evidence", async () => {
  const mock = createMockDb({
    delivery: readyDelivery(),
    claimCount: 0,
  });

  await assert.rejects(
    () =>
      claimChannexAriDelivery(mock.db as any, {
        deliveryId: "delivery-1",
        leaseToken: "lease-1",
        now: NOW,
      }),
    /CHANNEX_ARI_DISPATCH_CLAIM_RACE/
  );

  assert.equal(mock.state.deliveryUpdateArgs.length, 1);
  assert.equal(mock.state.attemptCreateArgs.length, 0);
  assert.equal(mock.state.propertyUpsertArgs.length, 0);
});

test("rejects claim for a missing delivery", async () => {
  const mock = createMockDb({ delivery: null });

  await assert.rejects(
    () =>
      claimChannexAriDelivery(mock.db as any, {
        deliveryId: "delivery-missing",
        leaseToken: "lease-1",
        now: NOW,
      }),
    /CHANNEX_ARI_DISPATCH_DELIVERY_NOT_FOUND/
  );
});

test("recovers a stale lease into RETRY_WAIT with fenced delivery and attempt updates", async () => {
  const delivery = readyDelivery({
    status: "PROCESSING",
    attemptCount: 2,
    nextAttemptAt: null,
    leaseToken: "lease-2",
    leaseExpiresAt: LEASE_EXPIRED_AT,
  });
  const attempt = inFlightAttempt();
  const existingPause = new Date("2026-07-28T12:10:00.000Z");
  const mock = createMockDb({
    delivery,
    attempt,
    propertyState: propertyState({ pausedUntil: existingPause }),
  });

  const result = await recoverStaleChannexAriDeliveryLease(mock.db as any, {
    deliveryId: "delivery-1",
    now: NOW,
    jitterMs: 1_000,
  });

  assert.equal(mock.state.isolationLevel, "Serializable");
  assert.deepEqual(mock.state.attemptFindArgs[0], {
    where: {
      deliveryId_attemptNumber: {
        deliveryId: "delivery-1",
        attemptNumber: 2,
      },
    },
    select: {
      id: true,
      outcome: true,
      startedAt: true,
      completedAt: true,
    },
  });
  assert.deepEqual(mock.state.deliveryUpdateArgs[0].where, {
    id: "delivery-1",
    status: "PROCESSING",
    attemptCount: 2,
    leaseToken: "lease-2",
    leaseExpiresAt: LEASE_EXPIRED_AT,
  });
  assert.equal(mock.state.deliveryUpdateArgs[0].data.status, "RETRY_WAIT");
  assert.deepEqual(
    mock.state.deliveryUpdateArgs[0].data.nextAttemptAt,
    new Date("2026-07-28T12:02:01.000Z")
  );
  assert.deepEqual(mock.state.attemptUpdateArgs[0], {
    where: {
      id: "attempt-2",
      outcome: "IN_FLIGHT",
      completedAt: null,
    },
    data: {
      outcome: "UNKNOWN_AFTER_LEASE",
      completedAt: NOW,
      errorCode: "CHANNEX_ARI_LEASE_EXPIRED",
      durationMs: 180_000,
    },
  });
  assert.deepEqual(mock.state.propertyUpsertArgs[0].update, {
    pausedUntil: existingPause,
  });
  assert.equal(result.exhausted, false);
  assert.equal(result.retryDelayMs, 121_000);
  assert.deepEqual(result.propertyStateUpdate.pausedUntil, existingPause);
});

test("recovers a stale final attempt into DEAD", async () => {
  const delivery = readyDelivery({
    status: "PROCESSING",
    attemptCount: CHANNEX_ARI_MAX_ATTEMPTS,
    nextAttemptAt: null,
    leaseToken: "lease-final",
    leaseExpiresAt: LEASE_EXPIRED_AT,
  });
  const attempt = inFlightAttempt({
    id: "attempt-final",
    attemptNumber: CHANNEX_ARI_MAX_ATTEMPTS,
  });
  const mock = createMockDb({ delivery, attempt });

  const result = await recoverStaleChannexAriDeliveryLease(mock.db as any, {
    deliveryId: "delivery-1",
    now: NOW,
  });

  assert.equal(result.exhausted, true);
  assert.equal(result.retryDelayMs, null);
  assert.equal(result.deliveryUpdate.status, "DEAD");
  assert.deepEqual(result.deliveryUpdate.deadAt, NOW);
  assert.equal(
    result.attemptUpdate.errorCode,
    "CHANNEX_ARI_LEASE_EXPIRED_AFTER_MAX_ATTEMPTS"
  );
});

test("rejects stale recovery when attempt evidence is absent or already terminal", async () => {
  const delivery = readyDelivery({
    status: "PROCESSING",
    attemptCount: 2,
    nextAttemptAt: null,
    leaseToken: "lease-2",
    leaseExpiresAt: LEASE_EXPIRED_AT,
  });

  const missing = createMockDb({ delivery, attempt: null });
  await assert.rejects(
    () =>
      recoverStaleChannexAriDeliveryLease(missing.db as any, {
        deliveryId: "delivery-1",
        now: NOW,
      }),
    /CHANNEX_ARI_STALE_ATTEMPT_EVIDENCE_MISSING/
  );

  const completed = createMockDb({
    delivery,
    attempt: inFlightAttempt({
      outcome: "SUCCESS",
      completedAt: new Date("2026-07-28T11:59:00.000Z"),
    }),
  });
  await assert.rejects(
    () =>
      recoverStaleChannexAriDeliveryLease(completed.db as any, {
        deliveryId: "delivery-1",
        now: NOW,
      }),
    /CHANNEX_ARI_STALE_ATTEMPT_STATE_INVALID/
  );
});

test("rejects a stale-delivery recovery race before mutating attempt evidence", async () => {
  const delivery = readyDelivery({
    status: "PROCESSING",
    attemptCount: 2,
    nextAttemptAt: null,
    leaseToken: "lease-2",
    leaseExpiresAt: LEASE_EXPIRED_AT,
  });
  const mock = createMockDb({
    delivery,
    attempt: inFlightAttempt(),
    recoveryDeliveryCount: 0,
  });

  await assert.rejects(
    () =>
      recoverStaleChannexAriDeliveryLease(mock.db as any, {
        deliveryId: "delivery-1",
        now: NOW,
      }),
    /CHANNEX_ARI_STALE_DELIVERY_RECOVERY_RACE/
  );

  assert.equal(mock.state.attemptUpdateArgs.length, 0);
  assert.equal(mock.state.propertyUpsertArgs.length, 0);
});

test("detects an attempt-evidence recovery race", async () => {
  const delivery = readyDelivery({
    status: "PROCESSING",
    attemptCount: 2,
    nextAttemptAt: null,
    leaseToken: "lease-2",
    leaseExpiresAt: LEASE_EXPIRED_AT,
  });
  const mock = createMockDb({
    delivery,
    attempt: inFlightAttempt(),
    recoveryAttemptCount: 0,
  });

  await assert.rejects(
    () =>
      recoverStaleChannexAriDeliveryLease(mock.db as any, {
        deliveryId: "delivery-1",
        now: NOW,
      }),
    /CHANNEX_ARI_STALE_ATTEMPT_RECOVERY_RACE/
  );

  assert.equal(mock.state.propertyUpsertArgs.length, 0);
});
