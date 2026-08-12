import assert from "node:assert/strict";
import test from "node:test";

import { calculateChannexAriCanonicalJsonIntegrity } from "./channex-ari-canonical-json.policy";

import {
  CHANNEX_ARI_EXECUTOR_COMPLETION_RESERVE_MS,
  CHANNEX_ARI_EXECUTOR_MIN_TIMEOUT_MS,
  executeClaimedChannexAriDelivery,
} from "./channex-ari-delivery-executor.service";
import { CHANNEX_ARI_HTTP_MAX_TIMEOUT_MS } from "./channex-ari-http.client";
import { CHANNEX_ARI_MAX_ATTEMPTS } from "./channex-ari-lifecycle.policy";

const STARTED_AT = new Date("2026-07-28T12:00:00.000Z");
const COMPLETED_AT = new Date("2026-07-28T12:00:02.500Z");
const LEASE_EXPIRES_AT = new Date("2026-07-28T12:02:00.000Z");
const API_KEY = "secret-channex-api-key";

function payload() {
  return {
    values: [
      {
        property_id: "channex-property-1",
        room_type_id: "room-type-1",
        date: "2026-08-01",
        availability: 1,
      },
    ],
  };
}

function payloadEvidence(value = payload()) {
  const integrity =
    calculateChannexAriCanonicalJsonIntegrity(value);

  return {
    payload: value,
    payloadHash: integrity.payloadHash,
    payloadValueCount: value.values.length,
    payloadBytes: integrity.payloadBytes,
  };
}

function claimedDelivery(
  overrides: Partial<{
    id: string;
    organizationId: string;
    propertyId: string;
    connectionId: string;
    listingId: string;
    messageKind: "AVAILABILITY" | "RATES_RESTRICTIONS";
    status: "PROCESSING";
    payload: any;
    payloadHash: string;
    payloadValueCount: number;
    payloadBytes: number;
    attemptCount: number;
    leaseToken: string;
    leaseExpiresAt: Date;
  }> = {}
) {
  return {
    id: "delivery-1",
    organizationId: "org-1",
    propertyId: "property-1",
    connectionId: "connection-1",
    listingId: "listing-1",
    messageKind: "AVAILABILITY" as const,
    status: "PROCESSING" as const,
    ...payloadEvidence(),
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

test("accepts canonical integrity after PostgreSQL JSONB reorders object keys", async () => {
  const original = payload();
  const integrity =
    calculateChannexAriCanonicalJsonIntegrity(original);
  const postgresJsonbPayload = {
    values: [
      {
        date: "2026-08-01",
        property_id: "channex-property-1",
        availability: 1,
        room_type_id: "room-type-1",
      },
    ],
  };
  const delivery = claimedDelivery({
    payload: postgresJsonbPayload,
    payloadHash: integrity.payloadHash,
    payloadValueCount: 1,
    payloadBytes: integrity.payloadBytes,
  });
  let sendCount = 0;
  let completeCount = 0;

  await executeClaimedChannexAriDelivery({
    db: {} as any,
    delivery,
    apiKey: API_KEY,
    clock: createClock(STARTED_AT, COMPLETED_AT),
    send: (async (input: any) => {
      sendCount += 1;

      assert.deepEqual(
        input.payload,
        postgresJsonbPayload
      );

      return {
        endpoint: "/api/v1/availability",
        url: "https://staging.example.test/api/v1/availability",
        payloadBytes: integrity.payloadBytes,
        evidence: {
          httpStatus: 200,
          taskId: "task-jsonb-round-trip",
          warningCount: 0,
          retryAfterMs: null,
          responseMeta: {
            endpoint: "/api/v1/availability",
            method: "POST",
            messageKind: "AVAILABILITY",
            payloadBytes: integrity.payloadBytes,
          },
        },
      };
    }) as any,
    complete: (async () => {
      completeCount += 1;

      return {
        retryClass: "SUCCESS",
        exhausted: false,
        deliveryUpdate: { status: "SENT" },
      } as any;
    }) as any,
  });

  assert.equal(sendCount, 1);
  assert.equal(completeCount, 1);
});
test("orchestrates send then completion for a claimed delivery", async () => {
  const delivery = claimedDelivery();
  const calls: string[] = [];
  const sendInputs: any[] = [];
  const completeInputs: any[] = [];
  const evidence = {
    httpStatus: 200,
    taskId: "task-1",
    warningCount: 0,
    retryAfterMs: null,
    responseMeta: { requestId: "request-1" },
  };
  const completionResult = {
    retryClass: "SUCCESS",
    exhausted: false,
    deliveryUpdate: { status: "SENT" },
  };

  const result = await executeClaimedChannexAriDelivery({
    db: { name: "db" } as any,
    delivery,
    apiKey: API_KEY,
    baseUrl: "https://staging.example.test",
    timeoutMs: 15_000,
    completionReserveMs: 5_000,
    jitterMs: 321,
    clock: createClock(STARTED_AT, COMPLETED_AT),
    send: (async (input: any) => {
      calls.push("send");
      sendInputs.push(input);
      return {
        endpoint: "/api/v1/availability",
        url: "https://staging.example.test/api/v1/availability",
        payloadBytes: delivery.payloadBytes,
        evidence,
      };
    }) as any,
    complete: (async (db: any, input: any) => {
      calls.push("complete");
      completeInputs.push({ db, input });
      return completionResult as any;
    }) as any,
  });

  assert.deepEqual(calls, ["send", "complete"]);
  assert.deepEqual(sendInputs, [
    {
      messageKind: "AVAILABILITY",
      payload: delivery.payload,
      apiKey: API_KEY,
      baseUrl: "https://staging.example.test",
      timeoutMs: 15_000,
      receivedAt: STARTED_AT,
      transport: undefined,
    },
  ]);
  assert.deepEqual(completeInputs, [
    {
      db: { name: "db" },
      input: {
        deliveryId: "delivery-1",
        leaseToken: "lease-1",
        evidence,
        completedAt: COMPLETED_AT,
        jitterMs: 321,
      },
    },
  ]);
  assert.deepEqual(result, {
    delivery: {
      id: "delivery-1",
      organizationId: "org-1",
      propertyId: "property-1",
      connectionId: "connection-1",
      listingId: "listing-1",
      messageKind: "AVAILABILITY",
      attemptCount: 1,
      payloadHash: delivery.payloadHash,
      payloadValueCount: 1,
      payloadBytes: delivery.payloadBytes,
      leaseExpiresAt: LEASE_EXPIRES_AT,
    },
    request: {
      endpoint: "/api/v1/availability",
      url: "https://staging.example.test/api/v1/availability",
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
      durationMs: 2_500,
      timeoutMs: 15_000,
      completionReserveMs: 5_000,
      leaseRemainingAtStartMs: 120_000,
    },
    evidence,
    completion: completionResult,
  });
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
});

test("passes retry evidence unchanged into transactional completion", async () => {
  const delivery = claimedDelivery({
    messageKind: "RATES_RESTRICTIONS",
    attemptCount: 3,
  });
  const evidence = {
    httpStatus: 429,
    taskId: null,
    warningCount: 0,
    retryAfterMs: 180_000,
    errorCode: "RATE_LIMITED",
  };
  const completeInputs: any[] = [];

  const result = await executeClaimedChannexAriDelivery({
    db: {} as any,
    delivery,
    apiKey: API_KEY,
    clock: createClock(STARTED_AT, COMPLETED_AT),
    send: (async () => ({
      endpoint: "/api/v1/restrictions",
      url: "https://staging.example.test/api/v1/restrictions",
      payloadBytes: delivery.payloadBytes,
      evidence,
    })) as any,
    complete: (async (_db: any, input: any) => {
      completeInputs.push(input);
      return {
        retryClass: "RETRYABLE",
        exhausted: false,
        retryDelayMs: 180_000,
      } as any;
    }) as any,
  });

  assert.deepEqual(completeInputs[0].evidence, evidence);
  assert.equal(result.evidence, evidence);
  assert.equal(result.delivery.messageKind, "RATES_RESTRICTIONS");
  assert.equal(result.delivery.attemptCount, 3);
});

test("allows the exact certified lease budget boundary", async () => {
  const timeoutMs = CHANNEX_ARI_EXECUTOR_MIN_TIMEOUT_MS;
  const reserveMs = 0;
  const delivery = claimedDelivery({
    leaseExpiresAt: new Date(STARTED_AT.getTime() + timeoutMs),
  });
  let sent = false;

  await executeClaimedChannexAriDelivery({
    db: {} as any,
    delivery,
    apiKey: API_KEY,
    timeoutMs,
    completionReserveMs: reserveMs,
    clock: createClock(
      STARTED_AT,
      new Date(STARTED_AT.getTime() + timeoutMs - 1)
    ),
    send: (async () => {
      sent = true;
      return {
        endpoint: "/api/v1/availability",
        url: "https://staging.example.test/api/v1/availability",
        payloadBytes: delivery.payloadBytes,
        evidence: { httpStatus: 200, taskId: "task-1", warningCount: 0 },
      };
    }) as any,
    complete: (async () => ({ retryClass: "SUCCESS" })) as any,
  });

  assert.equal(sent, true);
});

test("rejects expired or insufficient lease budget before HTTP", async () => {
  for (const scenario of [
    {
      leaseExpiresAt: STARTED_AT,
      error: /CHANNEX_ARI_EXECUTOR_LEASE_EXPIRED_BEFORE_HTTP/,
    },
    {
      leaseExpiresAt: new Date(
        STARTED_AT.getTime() +
          CHANNEX_ARI_EXECUTOR_COMPLETION_RESERVE_MS +
          15_000 -
          1
      ),
      error: /CHANNEX_ARI_EXECUTOR_LEASE_BUDGET_INSUFFICIENT/,
    },
  ]) {
    let sent = false;
    let completed = false;

    await assert.rejects(
      () =>
        executeClaimedChannexAriDelivery({
          db: {} as any,
          delivery: claimedDelivery({ leaseExpiresAt: scenario.leaseExpiresAt }),
          apiKey: API_KEY,
          clock: createClock(STARTED_AT),
          send: (async () => {
            sent = true;
            throw new Error("unexpected send");
          }) as any,
          complete: (async () => {
            completed = true;
            throw new Error("unexpected completion");
          }) as any,
        }),
      scenario.error
    );

    assert.equal(sent, false);
    assert.equal(completed, false);
  }
});

test("does not complete when the clock moves backward or the lease expires after HTTP", async () => {
  for (const scenario of [
    {
      completedAt: new Date(STARTED_AT.getTime() - 1),
      error: /CHANNEX_ARI_EXECUTOR_CLOCK_MOVED_BACKWARD/,
    },
    {
      completedAt: LEASE_EXPIRES_AT,
      error: /CHANNEX_ARI_EXECUTOR_LEASE_EXPIRED_AFTER_HTTP/,
    },
  ]) {
    const delivery = claimedDelivery();
    let completed = false;

    await assert.rejects(
      () =>
        executeClaimedChannexAriDelivery({
          db: {} as any,
          delivery,
          apiKey: API_KEY,
          clock: createClock(STARTED_AT, scenario.completedAt),
          send: (async () => ({
            endpoint: "/api/v1/availability",
            url: "https://staging.example.test/api/v1/availability",
            payloadBytes: delivery.payloadBytes,
            evidence: { httpStatus: 200, taskId: "task-1", warningCount: 0 },
          })) as any,
          complete: (async () => {
            completed = true;
            return {} as any;
          }) as any,
        }),
      scenario.error
    );

    assert.equal(completed, false);
  }
});

test("rejects HTTP payload byte drift before completion", async () => {
  const delivery = claimedDelivery();
  let completed = false;

  await assert.rejects(
    () =>
      executeClaimedChannexAriDelivery({
        db: {} as any,
        delivery,
        apiKey: API_KEY,
        clock: createClock(STARTED_AT, COMPLETED_AT),
        send: (async () => ({
          endpoint: "/api/v1/availability",
          url: "https://staging.example.test/api/v1/availability",
          payloadBytes: delivery.payloadBytes + 1,
          evidence: { httpStatus: 200, taskId: "task-1", warningCount: 0 },
        })) as any,
        complete: (async () => {
          completed = true;
          return {} as any;
        }) as any,
      }),
    /CHANNEX_ARI_EXECUTOR_HTTP_PAYLOAD_BYTES_MISMATCH/
  );

  assert.equal(completed, false);
});

test("propagates send and completion failures without retrying locally", async () => {
  const delivery = claimedDelivery();
  let completionCalls = 0;

  await assert.rejects(
    () =>
      executeClaimedChannexAriDelivery({
        db: {} as any,
        delivery,
        apiKey: API_KEY,
        clock: createClock(STARTED_AT),
        send: (async () => {
          throw new Error("SEND_FAILED");
        }) as any,
        complete: (async () => {
          completionCalls += 1;
          return {} as any;
        }) as any,
      }),
    /SEND_FAILED/
  );
  assert.equal(completionCalls, 0);

  await assert.rejects(
    () =>
      executeClaimedChannexAriDelivery({
        db: {} as any,
        delivery,
        apiKey: API_KEY,
        clock: createClock(STARTED_AT, COMPLETED_AT),
        send: (async () => ({
          endpoint: "/api/v1/availability",
          url: "https://staging.example.test/api/v1/availability",
          payloadBytes: delivery.payloadBytes,
          evidence: { httpStatus: 200, taskId: "task-1", warningCount: 0 },
        })) as any,
        complete: (async () => {
          throw new Error("COMPLETION_FAILED");
        }) as any,
      }),
    /COMPLETION_FAILED/
  );
});

test("validates claimed delivery integrity before send", async () => {
  const valid = claimedDelivery();
  const invalidDeliveries = [
    {
      delivery: { ...valid, status: "READY" as "PROCESSING" },
      error: /CHANNEX_ARI_EXECUTOR_PROCESSING_REQUIRED/,
    },
    {
      delivery: { ...valid, id: " " },
      error: /CHANNEX_ARI_EXECUTOR_DELIVERY_ID_REQUIRED/,
    },
    {
      delivery: { ...valid, organizationId: " " },
      error: /CHANNEX_ARI_EXECUTOR_ORGANIZATION_ID_REQUIRED/,
    },
    {
      delivery: { ...valid, propertyId: " " },
      error: /CHANNEX_ARI_EXECUTOR_PROPERTY_ID_REQUIRED/,
    },
    {
      delivery: { ...valid, connectionId: " " },
      error: /CHANNEX_ARI_EXECUTOR_CONNECTION_ID_REQUIRED/,
    },
    {
      delivery: { ...valid, listingId: " " },
      error: /CHANNEX_ARI_EXECUTOR_LISTING_ID_REQUIRED/,
    },
    {
      delivery: { ...valid, messageKind: "INVALID" as "AVAILABILITY" },
      error: /CHANNEX_ARI_EXECUTOR_MESSAGE_KIND_INVALID/,
    },
    {
      delivery: { ...valid, attemptCount: 0 },
      error: /CHANNEX_ARI_EXECUTOR_ATTEMPT_COUNT_INVALID/,
    },
    {
      delivery: { ...valid, attemptCount: CHANNEX_ARI_MAX_ATTEMPTS + 1 },
      error: /CHANNEX_ARI_EXECUTOR_ATTEMPT_COUNT_INVALID/,
    },
    {
      delivery: { ...valid, leaseToken: " " },
      error: /CHANNEX_ARI_EXECUTOR_LEASE_TOKEN_REQUIRED/,
    },
    {
      delivery: { ...valid, leaseExpiresAt: new Date("invalid") },
      error: /CHANNEX_ARI_EXECUTOR_LEASE_EXPIRES_AT_INVALID/,
    },
    {
      delivery: { ...valid, payload: null },
      error: /CHANNEX_ARI_EXECUTOR_PAYLOAD_INVALID/,
    },
    {
      delivery: { ...valid, payload: { values: [] } },
      error: /CHANNEX_ARI_EXECUTOR_PAYLOAD_VALUES_REQUIRED/,
    },
    {
      delivery: { ...valid, payloadValueCount: 2 },
      error: /CHANNEX_ARI_EXECUTOR_VALUE_COUNT_MISMATCH/,
    },
    {
      delivery: { ...valid, payloadBytes: 0 },
      error: /CHANNEX_ARI_EXECUTOR_PAYLOAD_BYTES_INVALID/,
    },
    {
      delivery: { ...valid, payloadBytes: valid.payloadBytes + 1 },
      error: /CHANNEX_ARI_EXECUTOR_PAYLOAD_BYTES_MISMATCH/,
    },
    {
      delivery: { ...valid, payloadHash: " " },
      error: /CHANNEX_ARI_EXECUTOR_PAYLOAD_HASH_REQUIRED/,
    },
    {
      delivery: { ...valid, payloadHash: "x".repeat(64) },
      error: /CHANNEX_ARI_EXECUTOR_PAYLOAD_HASH_INVALID/,
    },
    {
      delivery: { ...valid, payloadHash: "0".repeat(64) },
      error: /CHANNEX_ARI_EXECUTOR_PAYLOAD_HASH_MISMATCH/,
    },
  ];

  for (const scenario of invalidDeliveries) {
    let sent = false;

    await assert.rejects(
      () =>
        executeClaimedChannexAriDelivery({
          db: {} as any,
          delivery: scenario.delivery,
          apiKey: API_KEY,
          clock: createClock(STARTED_AT),
          send: (async () => {
            sent = true;
            throw new Error("unexpected send");
          }) as any,
          complete: (async () => ({})) as any,
        }),
      scenario.error
    );

    assert.equal(sent, false);
  }
});

test("validates executor configuration before send", async () => {
  const delivery = claimedDelivery();
  const scenarios = [
    {
      input: { apiKey: " " },
      error: /CHANNEX_ARI_EXECUTOR_API_KEY_REQUIRED/,
    },
    {
      input: { apiKey: API_KEY, timeoutMs: CHANNEX_ARI_EXECUTOR_MIN_TIMEOUT_MS - 1 },
      error: /CHANNEX_ARI_EXECUTOR_TIMEOUT_INVALID/,
    },
    {
      input: { apiKey: API_KEY, timeoutMs: CHANNEX_ARI_HTTP_MAX_TIMEOUT_MS + 1 },
      error: /CHANNEX_ARI_EXECUTOR_TIMEOUT_INVALID/,
    },
    {
      input: { apiKey: API_KEY, completionReserveMs: -1 },
      error: /CHANNEX_ARI_EXECUTOR_COMPLETION_RESERVE_INVALID/,
    },
    {
      input: { apiKey: API_KEY, completionReserveMs: 60_001 },
      error: /CHANNEX_ARI_EXECUTOR_COMPLETION_RESERVE_INVALID/,
    },
  ];

  for (const scenario of scenarios) {
    let sent = false;

    await assert.rejects(
      () =>
        executeClaimedChannexAriDelivery({
          db: {} as any,
          delivery,
          ...scenario.input,
          clock: createClock(STARTED_AT),
          send: (async () => {
            sent = true;
            throw new Error("unexpected send");
          }) as any,
          complete: (async () => ({})) as any,
        } as any),
      scenario.error
    );

    assert.equal(sent, false);
  }
});

test("does not mutate the claimed delivery or payload", async () => {
  const delivery = claimedDelivery();
  const before = structuredClone(delivery);

  await executeClaimedChannexAriDelivery({
    db: {} as any,
    delivery,
    apiKey: API_KEY,
    clock: createClock(STARTED_AT, COMPLETED_AT),
    send: (async () => ({
      endpoint: "/api/v1/availability",
      url: "https://staging.example.test/api/v1/availability",
      payloadBytes: delivery.payloadBytes,
      evidence: { httpStatus: 200, taskId: "task-1", warningCount: 0 },
    })) as any,
    complete: (async () => ({ retryClass: "SUCCESS" })) as any,
  });

  assert.deepEqual(delivery, before);
});
