import assert from "node:assert/strict";
import test from "node:test";

import { buildChannexAriAttemptCompletion } from "./channex-ari-attempt-completion.policy";
import {
  CHANNEX_ARI_MAX_ATTEMPTS,
  CHANNEX_ARI_MIN_RATE_LIMIT_PAUSE_MS,
} from "./channex-ari-lifecycle.policy";

const STARTED_AT = new Date("2026-07-28T12:00:00.000Z");
const COMPLETED_AT = new Date("2026-07-28T12:00:02.500Z");
const LEASE_EXPIRES_AT = new Date("2026-07-28T12:02:00.000Z");

function delivery(
  overrides: Partial<{
    status: "PROCESSING";
    messageKind: "AVAILABILITY" | "RATES_RESTRICTIONS";
    syncMode: "INCREMENTAL" | "FULL";
    attemptCount: number;
    leaseToken: string;
    leaseExpiresAt: Date;
  }> = {}
) {
  return {
    status: "PROCESSING" as const,
    messageKind: "AVAILABILITY" as const,
    syncMode: "INCREMENTAL" as const,
    attemptCount: 1,
    leaseToken: "lease-1",
    leaseExpiresAt: LEASE_EXPIRES_AT,
    ...overrides,
  };
}

function attempt(
  overrides: Partial<{
    attemptNumber: number;
    outcome: "IN_FLIGHT";
    startedAt: Date;
    completedAt: Date | null;
  }> = {}
) {
  return {
    attemptNumber: 1,
    outcome: "IN_FLIGHT" as const,
    startedAt: STARTED_AT,
    completedAt: null,
    ...overrides,
  };
}

test("completes a successful Availability attempt as SENT with durable evidence", () => {
  const result = buildChannexAriAttemptCompletion({
    delivery: delivery(),
    attempt: attempt(),
    leaseToken: " lease-1 ",
    evidence: {
      httpStatus: 200,
      taskId: " task-123 ",
      warningCount: 0,
      responseMeta: { requestId: "req-1" },
    },
    completedAt: COMPLETED_AT,
  });

  assert.equal(result.retryClass, "SUCCESS");
  assert.equal(result.exhausted, false);
  assert.equal(result.retryDelayMs, null);
  assert.deepEqual(result.deliveryUpdate, {
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
  assert.deepEqual(result.attemptUpdate, {
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
  assert.deepEqual(result.propertyStateUpdate, {
    lastSuccessfulAvailabilityAt: COMPLETED_AT,
  });
});

test("records Rates & Restrictions Full Sync completion timestamps", () => {
  const result = buildChannexAriAttemptCompletion({
    delivery: delivery({
      messageKind: "RATES_RESTRICTIONS",
      syncMode: "FULL",
    }),
    attempt: attempt(),
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
});

test("treats a success HTTP response without task ID as SENT", () => {
  const result = buildChannexAriAttemptCompletion({
    delivery: delivery(),
    attempt: attempt(),
    leaseToken: "lease-1",
    evidence: {
      httpStatus: 200,
      warningCount: 0,
    },
    completedAt: COMPLETED_AT,
  });

  assert.equal(result.retryClass, "SUCCESS");
  assert.equal(result.exhausted, false);
  assert.equal(result.retryDelayMs, null);
  assert.deepEqual(result.deliveryUpdate, {
    status: "SENT",
    nextAttemptAt: null,
    leaseToken: null,
    leaseExpiresAt: null,
    channexTaskId: null,
    httpStatus: 200,
    warningCount: 0,
    lastErrorCode: null,
    lastErrorSummary: null,
    sentAt: COMPLETED_AT,
  });
  assert.deepEqual(result.attemptUpdate, {
    outcome: "SUCCESS",
    completedAt: COMPLETED_AT,
    durationMs: 2_500,
    httpStatus: 200,
    channexTaskId: null,
    warningCount: 0,
    retryAfterMs: null,
    errorCode: null,
    responseMeta: {
      retryClass: "SUCCESS",
      networkError: false,
      timedOut: false,
      leaseExpiresAt: LEASE_EXPIRES_AT.toISOString(),
    },
  });
  assert.deepEqual(result.propertyStateUpdate, {
    lastSuccessfulAvailabilityAt: COMPLETED_AT,
  });
});

test("treats rejected-value warnings as terminal even with task ID", () => {
  const result = buildChannexAriAttemptCompletion({
    delivery: delivery(),
    attempt: attempt(),
    leaseToken: "lease-1",
    evidence: {
      httpStatus: 200,
      taskId: "task-warning",
      warningCount: 2,
    },
    completedAt: COMPLETED_AT,
  });

  assert.equal(result.retryClass, "TERMINAL");
  assert.equal(result.deliveryUpdate.status, "DEAD");
  assert.equal(result.deliveryUpdate.channexTaskId, "task-warning");
  assert.equal(result.deliveryUpdate.warningCount, 2);
  assert.equal(
    result.deliveryUpdate.lastErrorCode,
    "CHANNEX_ARI_REJECTED_VALUE_WARNING"
  );
  assert.equal(
    result.deliveryUpdate.lastErrorSummary,
    "Channex returned 2 rejected-value warning(s)."
  );
});

test("uses caller-provided terminal error details within certified bounds", () => {
  const result = buildChannexAriAttemptCompletion({
    delivery: delivery(),
    attempt: attempt(),
    leaseToken: "lease-1",
    evidence: {
      httpStatus: 401,
      errorCode: "CHANNEX_AUTH_REJECTED",
      errorSummary: "The Channex credential was rejected.",
      responseMeta: { endpoint: "/restrictions" },
    },
    completedAt: COMPLETED_AT,
  });

  assert.equal(result.retryClass, "TERMINAL");
  assert.deepEqual(result.deliveryUpdate, {
    status: "DEAD",
    nextAttemptAt: null,
    leaseToken: null,
    leaseExpiresAt: null,
    channexTaskId: null,
    httpStatus: 401,
    warningCount: 0,
    lastErrorCode: "CHANNEX_AUTH_REJECTED",
    lastErrorSummary: "The Channex credential was rejected.",
    deadAt: COMPLETED_AT,
  });
  assert.deepEqual(result.attemptUpdate.responseMeta, {
    endpoint: "/restrictions",
    retryClass: "TERMINAL",
    networkError: false,
    timedOut: false,
    leaseExpiresAt: LEASE_EXPIRES_AT.toISOString(),
    errorSummary: "The Channex credential was rejected.",
  });
});

test("schedules a 429 retry using Retry-After and preserves a longer property pause", () => {
  const existingPause = new Date("2026-07-28T12:10:00.000Z");
  const result = buildChannexAriAttemptCompletion({
    delivery: delivery({ attemptCount: 2 }),
    attempt: attempt({ attemptNumber: 2 }),
    leaseToken: "lease-1",
    evidence: {
      httpStatus: 429,
      retryAfterMs: 180_000,
    },
    propertyState: {
      pausedUntil: existingPause,
    },
    completedAt: COMPLETED_AT,
    jitterMs: 1_000,
  });

  assert.equal(result.retryClass, "RETRYABLE");
  assert.equal(result.exhausted, false);
  assert.equal(result.retryDelayMs, 181_000);
  assert.deepEqual(result.deliveryUpdate, {
    status: "RETRY_WAIT",
    nextAttemptAt: new Date(COMPLETED_AT.getTime() + 181_000),
    leaseToken: null,
    leaseExpiresAt: null,
    channexTaskId: null,
    httpStatus: 429,
    warningCount: 0,
    lastErrorCode: "CHANNEX_ARI_RATE_LIMITED",
    lastErrorSummary: "Channex rate-limited the ARI request.",
  });
  assert.equal(result.attemptUpdate.outcome, "RETRYABLE_FAILURE");
  assert.equal(result.attemptUpdate.retryAfterMs, 180_000);
  assert.deepEqual(result.propertyStateUpdate, {
    pausedUntil: existingPause,
    lastRateLimitAt: COMPLETED_AT,
  });
});

test("uses exponential retry delay for upstream 5xx", () => {
  const result = buildChannexAriAttemptCompletion({
    delivery: delivery({ attemptCount: 3 }),
    attempt: attempt({ attemptNumber: 3 }),
    leaseToken: "lease-1",
    evidence: {
      httpStatus: 503,
    },
    completedAt: COMPLETED_AT,
  });

  const expectedDelay = CHANNEX_ARI_MIN_RATE_LIMIT_PAUSE_MS * 4;
  assert.equal(result.retryClass, "RETRYABLE");
  assert.equal(result.retryDelayMs, expectedDelay);
  assert.equal(result.deliveryUpdate.status, "RETRY_WAIT");
  assert.deepEqual(
    result.deliveryUpdate.nextAttemptAt,
    new Date(COMPLETED_AT.getTime() + expectedDelay)
  );
  assert.equal(result.deliveryUpdate.lastErrorCode, "CHANNEX_ARI_UPSTREAM_5XX");
  assert.deepEqual(result.propertyStateUpdate, {
    pausedUntil: new Date(COMPLETED_AT.getTime() + expectedDelay),
  });
});

test("records network and timeout evidence as retryable failures", () => {
  const network = buildChannexAriAttemptCompletion({
    delivery: delivery(),
    attempt: attempt(),
    leaseToken: "lease-1",
    evidence: {
      networkError: true,
      responseMeta: { syscall: "ECONNRESET" },
    },
    completedAt: COMPLETED_AT,
  });

  assert.equal(network.retryClass, "RETRYABLE");
  assert.equal(network.attemptUpdate.httpStatus, null);
  assert.equal(network.attemptUpdate.errorCode, "CHANNEX_ARI_NETWORK_ERROR");
  assert.deepEqual(network.attemptUpdate.responseMeta, {
    syscall: "ECONNRESET",
    retryClass: "RETRYABLE",
    networkError: true,
    timedOut: false,
    leaseExpiresAt: LEASE_EXPIRES_AT.toISOString(),
    errorSummary: "Channex ARI request failed before an HTTP response.",
  });

  const timeout = buildChannexAriAttemptCompletion({
    delivery: delivery(),
    attempt: attempt(),
    leaseToken: "lease-1",
    evidence: {
      timedOut: true,
    },
    completedAt: COMPLETED_AT,
  });

  assert.equal(timeout.retryClass, "RETRYABLE");
  assert.equal(timeout.attemptUpdate.errorCode, "CHANNEX_ARI_TIMEOUT");
});

test("closes a retryable final attempt as DEAD while retaining RETRYABLE_FAILURE evidence", () => {
  const result = buildChannexAriAttemptCompletion({
    delivery: delivery({ attemptCount: CHANNEX_ARI_MAX_ATTEMPTS }),
    attempt: attempt({ attemptNumber: CHANNEX_ARI_MAX_ATTEMPTS }),
    leaseToken: "lease-1",
    evidence: {
      httpStatus: 503,
    },
    completedAt: COMPLETED_AT,
  });

  assert.equal(result.retryClass, "RETRYABLE");
  assert.equal(result.exhausted, true);
  assert.equal(result.deliveryUpdate.status, "DEAD");
  assert.deepEqual(result.deliveryUpdate.deadAt, COMPLETED_AT);
  assert.equal(result.deliveryUpdate.nextAttemptAt, null);
  assert.equal(result.attemptUpdate.outcome, "RETRYABLE_FAILURE");
  assert.ok(result.retryDelayMs >= CHANNEX_ARI_MIN_RATE_LIMIT_PAUSE_MS);
});

test("enforces lease-token and attempt-number fencing", () => {
  assert.throws(
    () =>
      buildChannexAriAttemptCompletion({
        delivery: delivery(),
        attempt: attempt(),
        leaseToken: "other-lease",
        evidence: { httpStatus: 200, taskId: "task-1" },
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_LEASE_TOKEN_MISMATCH/
  );

  assert.throws(
    () =>
      buildChannexAriAttemptCompletion({
        delivery: delivery({ attemptCount: 2 }),
        attempt: attempt({ attemptNumber: 1 }),
        leaseToken: "lease-1",
        evidence: { httpStatus: 200, taskId: "task-1" },
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_ATTEMPT_NUMBER_MISMATCH/
  );
});

test("rejects completed attempts and completion timestamps before start", () => {
  assert.throws(
    () =>
      buildChannexAriAttemptCompletion({
        delivery: delivery(),
        attempt: attempt({ completedAt: STARTED_AT }),
        leaseToken: "lease-1",
        evidence: { httpStatus: 200, taskId: "task-1" },
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_ATTEMPT_STATE_INVALID/
  );

  assert.throws(
    () =>
      buildChannexAriAttemptCompletion({
        delivery: delivery(),
        attempt: attempt(),
        leaseToken: "lease-1",
        evidence: { httpStatus: 200, taskId: "task-1" },
        completedAt: new Date(STARTED_AT.getTime() - 1),
      }),
    /CHANNEX_ARI_COMPLETION_BEFORE_ATTEMPT_START/
  );
});

test("requires one coherent transport outcome", () => {
  assert.throws(
    () =>
      buildChannexAriAttemptCompletion({
        delivery: delivery(),
        attempt: attempt(),
        leaseToken: "lease-1",
        evidence: {},
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_TRANSPORT_EVIDENCE_REQUIRED/
  );

  assert.throws(
    () =>
      buildChannexAriAttemptCompletion({
        delivery: delivery(),
        attempt: attempt(),
        leaseToken: "lease-1",
        evidence: { httpStatus: 503, networkError: true },
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_TRANSPORT_EVIDENCE_CONFLICT/
  );
});

test("validates HTTP, warning, Retry-After and response metadata evidence", () => {
  for (const httpStatus of [99, 600, 200.5]) {
    assert.throws(
      () =>
        buildChannexAriAttemptCompletion({
          delivery: delivery(),
          attempt: attempt(),
          leaseToken: "lease-1",
          evidence: { httpStatus },
          completedAt: COMPLETED_AT,
        }),
      /CHANNEX_ARI_COMPLETION_HTTP_STATUS_INVALID/
    );
  }

  assert.throws(
    () =>
      buildChannexAriAttemptCompletion({
        delivery: delivery(),
        attempt: attempt(),
        leaseToken: "lease-1",
        evidence: { httpStatus: 200, taskId: "task-1", warningCount: -1 },
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_WARNING_COUNT_INVALID/
  );

  assert.throws(
    () =>
      buildChannexAriAttemptCompletion({
        delivery: delivery(),
        attempt: attempt(),
        leaseToken: "lease-1",
        evidence: { httpStatus: 429, retryAfterMs: 1.5 },
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_RETRY_AFTER_MS_INVALID/
  );

  assert.throws(
    () =>
      buildChannexAriAttemptCompletion({
        delivery: delivery(),
        attempt: attempt(),
        leaseToken: "lease-1",
        evidence: {
          httpStatus: 200,
          taskId: "task-1",
          responseMeta: [] as unknown as Record<string, unknown>,
        },
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_RESPONSE_META_INVALID/
  );
});

test("rejects oversized task and error evidence", () => {
  assert.throws(
    () =>
      buildChannexAriAttemptCompletion({
        delivery: delivery(),
        attempt: attempt(),
        leaseToken: "lease-1",
        evidence: { httpStatus: 200, taskId: "x".repeat(257) },
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_TASK_ID_TOO_LONG/
  );

  assert.throws(
    () =>
      buildChannexAriAttemptCompletion({
        delivery: delivery(),
        attempt: attempt(),
        leaseToken: "lease-1",
        evidence: { httpStatus: 401, errorCode: "x".repeat(129) },
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_ERROR_CODE_TOO_LONG/
  );

  assert.throws(
    () =>
      buildChannexAriAttemptCompletion({
        delivery: delivery(),
        attempt: attempt(),
        leaseToken: "lease-1",
        evidence: { httpStatus: 401, errorSummary: "x".repeat(1_001) },
        completedAt: COMPLETED_AT,
      }),
    /CHANNEX_ARI_COMPLETION_ERROR_SUMMARY_TOO_LONG/
  );
});
