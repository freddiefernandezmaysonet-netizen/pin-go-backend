import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEX_ARI_OUTBOX_DEFAULT_CLAIM_LEASE_MS,
  CHANNEX_ARI_OUTBOX_MAX_MATERIALIZATION_ATTEMPTS,
  buildChannexAriOutboxMaterializationClaim,
  buildChannexAriOutboxMaterializationFailure,
  buildChannexAriOutboxStaleClaimRecovery,
} from "./channex-ari-outbox-materialization.policy";

const AVAILABLE_AT = new Date("2026-07-29T12:00:00.000Z");
const CLAIMED_AT = new Date("2026-07-29T12:01:00.000Z");
const CLAIM_EXPIRES_AT = new Date(
  CLAIMED_AT.getTime() + CHANNEX_ARI_OUTBOX_DEFAULT_CLAIM_LEASE_MS
);
const CLAIM_TOKEN = "claim-token-1";

function pendingState(overrides: Record<string, unknown> = {}) {
  return {
    status: "PENDING" as const,
    materializationAttemptCount: 0,
    availableAt: AVAILABLE_AT,
    claimedAt: null,
    claimToken: null,
    claimExpiresAt: null,
    deliveryId: null,
    ...overrides,
  } as any;
}

function claimedState(overrides: Record<string, unknown> = {}) {
  return {
    status: "CLAIMED" as const,
    materializationAttemptCount: 1,
    availableAt: AVAILABLE_AT,
    claimedAt: CLAIMED_AT,
    claimToken: CLAIM_TOKEN,
    claimExpiresAt: CLAIM_EXPIRES_AT,
    deliveryId: null,
    ...overrides,
  } as any;
}

test("builds a fenced claim and increments materialization attempts", () => {
  const state = pendingState();
  const before = structuredClone(state);

  assert.deepEqual(
    buildChannexAriOutboxMaterializationClaim({
      state,
      claimToken: CLAIM_TOKEN,
      claimedAt: CLAIMED_AT,
    }),
    {
      status: "CLAIMED",
      materializationAttemptCount: 1,
      claimedAt: CLAIMED_AT,
      claimToken: CLAIM_TOKEN,
      claimExpiresAt: CLAIM_EXPIRES_AT,
      lastErrorCode: null,
      lastErrorSummary: null,
      deadAt: null,
    }
  );
  assert.deepEqual(state, before);
});

test("accepts claim lease boundaries and rejects invalid leases", () => {
  assert.equal(
    buildChannexAriOutboxMaterializationClaim({
      state: pendingState(),
      claimToken: CLAIM_TOKEN,
      claimedAt: CLAIMED_AT,
      leaseMs: 30_000,
    }).claimExpiresAt.getTime(),
    CLAIMED_AT.getTime() + 30_000
  );
  assert.equal(
    buildChannexAriOutboxMaterializationClaim({
      state: pendingState(),
      claimToken: CLAIM_TOKEN,
      claimedAt: CLAIMED_AT,
      leaseMs: 300_000,
    }).claimExpiresAt.getTime(),
    CLAIMED_AT.getTime() + 300_000
  );

  for (const leaseMs of [29_999, 300_001, 1.5, Number.NaN]) {
    assert.throws(
      () =>
        buildChannexAriOutboxMaterializationClaim({
          state: pendingState(),
          claimToken: CLAIM_TOKEN,
          claimedAt: CLAIMED_AT,
          leaseMs,
        }),
      /CHANNEX_ARI_OUTBOX_CLAIM_LEASE_INVALID/
    );
  }
});

test("rejects ineligible or malformed claim state", () => {
  const scenarios: Array<[Record<string, unknown>, RegExp]> = [
    [{ status: "CLAIMED" }, /CHANNEX_ARI_OUTBOX_CLAIM_PENDING_REQUIRED/],
    [{ claimedAt: CLAIMED_AT }, /CHANNEX_ARI_OUTBOX_CLAIM_ALREADY_PRESENT/],
    [{ claimToken: CLAIM_TOKEN }, /CHANNEX_ARI_OUTBOX_CLAIM_ALREADY_PRESENT/],
    [{ claimExpiresAt: CLAIM_EXPIRES_AT }, /CHANNEX_ARI_OUTBOX_CLAIM_ALREADY_PRESENT/],
    [{ deliveryId: "delivery-1" }, /CHANNEX_ARI_OUTBOX_CLAIM_DELIVERY_PRESENT/],
    [{ availableAt: new Date(CLAIMED_AT.getTime() + 1) }, /CHANNEX_ARI_OUTBOX_EVENT_NOT_READY/],
    [{ materializationAttemptCount: -1 }, /CHANNEX_ARI_OUTBOX_MATERIALIZATION_ATTEMPT_COUNT_INVALID/],
    [{ materializationAttemptCount: 1.5 }, /CHANNEX_ARI_OUTBOX_MATERIALIZATION_ATTEMPT_COUNT_INVALID/],
    [
      { materializationAttemptCount: CHANNEX_ARI_OUTBOX_MAX_MATERIALIZATION_ATTEMPTS },
      /CHANNEX_ARI_OUTBOX_MATERIALIZATION_ATTEMPTS_EXHAUSTED/,
    ],
    [{ availableAt: new Date("invalid") }, /CHANNEX_ARI_OUTBOX_AVAILABLE_AT_INVALID/],
  ];

  for (const [overrides, error] of scenarios) {
    assert.throws(
      () =>
        buildChannexAriOutboxMaterializationClaim({
          state: pendingState(overrides),
          claimToken: CLAIM_TOKEN,
          claimedAt: CLAIMED_AT,
        }),
      error
    );
  }
});

test("requires a bounded non-whitespace claim token", () => {
  for (const claimToken of ["", " ", "token with spaces", "x".repeat(129)]) {
    assert.throws(
      () =>
        buildChannexAriOutboxMaterializationClaim({
          state: pendingState(),
          claimToken,
          claimedAt: CLAIMED_AT,
        }),
      /CHANNEX_ARI_OUTBOX_MATERIALIZATION_CLAIM_TOKEN_(?:REQUIRED|INVALID)/
    );
  }
});

test("releases a retryable materialization failure with exponential delay", () => {
  const failedAt = new Date("2026-07-29T12:01:30.000Z");
  const state = claimedState();
  const before = structuredClone(state);

  assert.deepEqual(
    buildChannexAriOutboxMaterializationFailure({
      state,
      claimToken: CLAIM_TOKEN,
      failedAt,
      errorCode: "CHANNEX_ARI_MAPPING_TEMPORARILY_UNAVAILABLE",
      errorSummary: "Mapping lookup unavailable",
      jitterMs: 250,
    }),
    {
      status: "PENDING",
      availableAt: new Date(failedAt.getTime() + 60_250),
      claimedAt: null,
      claimToken: null,
      claimExpiresAt: null,
      lastErrorCode: "CHANNEX_ARI_MAPPING_TEMPORARILY_UNAVAILABLE",
      lastErrorSummary: "Mapping lookup unavailable",
      deadAt: null,
    }
  );
  assert.deepEqual(state, before);
});

test("marks terminal and exhausted materialization failures dead", () => {
  const failedAt = new Date("2026-07-29T12:01:30.000Z");

  for (const state of [
    claimedState(),
    claimedState({
      materializationAttemptCount:
        CHANNEX_ARI_OUTBOX_MAX_MATERIALIZATION_ATTEMPTS,
    }),
  ]) {
    const result = buildChannexAriOutboxMaterializationFailure({
      state,
      claimToken: CLAIM_TOKEN,
      failedAt,
      errorCode: "CHANNEX_ARI_MAPPING_INVALID",
      terminal: state.materializationAttemptCount === 1,
    });

    assert.deepEqual(result, {
      status: "DEAD",
      availableAt: AVAILABLE_AT,
      claimedAt: null,
      claimToken: null,
      claimExpiresAt: null,
      lastErrorCode: "CHANNEX_ARI_MAPPING_INVALID",
      lastErrorSummary: null,
      deadAt: failedAt,
    });
  }
});

test("fences failure completion by claim token and lease window", () => {
  const validFailure = {
    state: claimedState(),
    claimToken: CLAIM_TOKEN,
    failedAt: new Date(CLAIMED_AT.getTime() + 1_000),
    errorCode: "CHANNEX_ARI_MATERIALIZATION_FAILED",
  };

  assert.throws(
    () =>
      buildChannexAriOutboxMaterializationFailure({
        ...validFailure,
        claimToken: "other-token",
      }),
    /CHANNEX_ARI_OUTBOX_MATERIALIZATION_CLAIM_TOKEN_MISMATCH/
  );
  assert.throws(
    () =>
      buildChannexAriOutboxMaterializationFailure({
        ...validFailure,
        failedAt: CLAIM_EXPIRES_AT,
      }),
    /CHANNEX_ARI_OUTBOX_MATERIALIZATION_CLAIM_EXPIRED/
  );
  assert.throws(
    () =>
      buildChannexAriOutboxMaterializationFailure({
        ...validFailure,
        failedAt: new Date(CLAIMED_AT.getTime() - 1),
      }),
    /CHANNEX_ARI_OUTBOX_MATERIALIZATION_CLOCK_MOVED_BACKWARD/
  );
  assert.throws(
    () =>
      buildChannexAriOutboxMaterializationFailure({
        ...validFailure,
        state: claimedState({ claimExpiresAt: null }),
      }),
    /CHANNEX_ARI_OUTBOX_MATERIALIZATION_CLAIM_EXPIRES_AT_INVALID/
  );
  assert.throws(
    () =>
      buildChannexAriOutboxMaterializationFailure({
        ...validFailure,
        state: claimedState({ claimedAt: null }),
      }),
    /CHANNEX_ARI_OUTBOX_MATERIALIZATION_CLAIMED_AT_INVALID/
  );
});

test("validates public error evidence", () => {
  const base = {
    state: claimedState(),
    claimToken: CLAIM_TOKEN,
    failedAt: new Date(CLAIMED_AT.getTime() + 1_000),
  };

  for (const errorCode of ["", "unsafe-message", "x".repeat(129)]) {
    assert.throws(
      () =>
        buildChannexAriOutboxMaterializationFailure({
          ...base,
          errorCode,
        }),
      /CHANNEX_ARI_OUTBOX_MATERIALIZATION_ERROR_CODE_(?:REQUIRED|INVALID)/
    );
  }
  assert.throws(
    () =>
      buildChannexAriOutboxMaterializationFailure({
        ...base,
        errorCode: "SAFE_ERROR",
        errorSummary: "x".repeat(513),
      }),
    /CHANNEX_ARI_OUTBOX_MATERIALIZATION_ERROR_SUMMARY_INVALID/
  );
});

test("recovers a stale claim with a fenced retry delay", () => {
  const recoveredAt = CLAIM_EXPIRES_AT;

  assert.deepEqual(
    buildChannexAriOutboxStaleClaimRecovery({
      state: claimedState(),
      recoveredAt,
      jitterMs: 500,
    }),
    {
      status: "PENDING",
      availableAt: new Date(recoveredAt.getTime() + 60_500),
      claimedAt: null,
      claimToken: null,
      claimExpiresAt: null,
      lastErrorCode: "CHANNEX_ARI_OUTBOX_CLAIM_STALE",
      lastErrorSummary: null,
      deadAt: null,
    }
  );
});

test("marks an exhausted stale claim dead", () => {
  assert.deepEqual(
    buildChannexAriOutboxStaleClaimRecovery({
      state: claimedState({
        materializationAttemptCount:
          CHANNEX_ARI_OUTBOX_MAX_MATERIALIZATION_ATTEMPTS,
      }),
      recoveredAt: CLAIM_EXPIRES_AT,
    }),
    {
      status: "DEAD",
      availableAt: AVAILABLE_AT,
      claimedAt: null,
      claimToken: null,
      claimExpiresAt: null,
      lastErrorCode: "CHANNEX_ARI_OUTBOX_CLAIM_STALE",
      lastErrorSummary: null,
      deadAt: CLAIM_EXPIRES_AT,
    }
  );
});

test("rejects non-stale or malformed stale claims", () => {
  const scenarios: Array<[Record<string, unknown>, Date, RegExp]> = [
    [{ status: "PENDING" }, CLAIM_EXPIRES_AT, /CHANNEX_ARI_OUTBOX_STALE_CLAIMED_REQUIRED/],
    [{ claimToken: null }, CLAIM_EXPIRES_AT, /CHANNEX_ARI_OUTBOX_MATERIALIZATION_CLAIM_TOKEN_REQUIRED/],
    [{ claimedAt: null }, CLAIM_EXPIRES_AT, /CHANNEX_ARI_OUTBOX_STALE_CLAIMED_AT_INVALID/],
    [{ claimExpiresAt: null }, CLAIM_EXPIRES_AT, /CHANNEX_ARI_OUTBOX_STALE_CLAIM_EXPIRES_AT_INVALID/],
    [{ deliveryId: "delivery-1" }, CLAIM_EXPIRES_AT, /CHANNEX_ARI_OUTBOX_STALE_DELIVERY_PRESENT/],
    [{ claimExpiresAt: CLAIMED_AT }, CLAIM_EXPIRES_AT, /CHANNEX_ARI_OUTBOX_STALE_CLAIM_WINDOW_INVALID/],
    [{}, new Date(CLAIM_EXPIRES_AT.getTime() - 1), /CHANNEX_ARI_OUTBOX_CLAIM_NOT_STALE/],
  ];

  for (const [overrides, recoveredAt, error] of scenarios) {
    assert.throws(
      () =>
        buildChannexAriOutboxStaleClaimRecovery({
          state: claimedState(overrides),
          recoveredAt,
        }),
      error
    );
  }
});
