import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEX_ARI_DEFAULT_LEASE_MS,
  CHANNEX_ARI_MAX_LEASE_MS,
  CHANNEX_ARI_MIN_LEASE_MS,
  buildChannexAriDispatchClaim,
  buildChannexAriPropertyPause,
  buildChannexAriStaleLeaseRecovery,
  evaluateChannexAriDispatchEligibility,
  getChannexAriDispatchWakeAt,
} from "./channex-ari-dispatch.policy";
import {
  CHANNEX_ARI_MAX_ATTEMPTS,
  CHANNEX_ARI_MIN_RATE_LIMIT_PAUSE_MS,
  CHANNEX_ARI_MIN_SAME_KIND_SPACING_MS,
} from "./channex-ari-lifecycle.policy";

const NOW = new Date("2026-07-28T12:00:00.000Z");

function readyDelivery(
  overrides: Partial<{
    status: "READY" | "PROCESSING" | "RETRY_WAIT" | "SENT" | "DEAD" | "SUPERSEDED";
    messageKind: "AVAILABILITY" | "RATES_RESTRICTIONS";
    attemptCount: number;
    nextAttemptAt: Date | null;
    leaseToken: string | null;
    leaseExpiresAt: Date | null;
  }> = {}
) {
  return {
    status: "READY" as const,
    messageKind: "AVAILABILITY" as const,
    attemptCount: 0,
    nextAttemptAt: NOW,
    leaseToken: null,
    leaseExpiresAt: null,
    ...overrides,
  };
}

test("marks a due READY delivery eligible when no property blocker exists", () => {
  assert.deepEqual(
    evaluateChannexAriDispatchEligibility({
      delivery: readyDelivery(),
      propertyState: {},
      now: NOW,
    }),
    {
      eligible: true,
      reason: null,
      nextEligibleAt: null,
    }
  );
});

test("honors next-attempt, property pause and per-kind throttling independently", () => {
  const nextAttemptAt = new Date("2026-07-28T12:01:00.000Z");
  assert.deepEqual(
    evaluateChannexAriDispatchEligibility({
      delivery: readyDelivery({
        status: "RETRY_WAIT",
        attemptCount: 1,
        nextAttemptAt,
      }),
      now: NOW,
    }),
    {
      eligible: false,
      reason: "NEXT_ATTEMPT_PENDING",
      nextEligibleAt: nextAttemptAt,
    }
  );

  const pausedUntil = new Date("2026-07-28T12:02:00.000Z");
  assert.deepEqual(
    evaluateChannexAriDispatchEligibility({
      delivery: readyDelivery(),
      propertyState: { pausedUntil },
      now: NOW,
    }),
    {
      eligible: false,
      reason: "PROPERTY_PAUSED",
      nextEligibleAt: pausedUntil,
    }
  );

  const availabilityNextAllowedAt = new Date("2026-07-28T12:00:06.500Z");
  assert.deepEqual(
    evaluateChannexAriDispatchEligibility({
      delivery: readyDelivery({ messageKind: "AVAILABILITY" }),
      propertyState: {
        availabilityNextAllowedAt,
        ratesNextAllowedAt: new Date("2026-07-28T12:10:00.000Z"),
      },
      now: NOW,
    }),
    {
      eligible: false,
      reason: "KIND_THROTTLED",
      nextEligibleAt: availabilityNextAllowedAt,
    }
  );

  assert.equal(
    evaluateChannexAriDispatchEligibility({
      delivery: readyDelivery({ messageKind: "RATES_RESTRICTIONS" }),
      propertyState: {
        availabilityNextAllowedAt: new Date("2026-07-28T12:10:00.000Z"),
      },
      now: NOW,
    }).eligible,
    true
  );
});

test("distinguishes an active PROCESSING lease from a stale lease", () => {
  const activeLeaseExpiry = new Date("2026-07-28T12:00:30.000Z");
  assert.deepEqual(
    evaluateChannexAriDispatchEligibility({
      delivery: readyDelivery({
        status: "PROCESSING",
        attemptCount: 1,
        nextAttemptAt: null,
        leaseToken: "lease-1",
        leaseExpiresAt: activeLeaseExpiry,
      }),
      now: NOW,
    }),
    {
      eligible: false,
      reason: "ACTIVE_LEASE",
      nextEligibleAt: activeLeaseExpiry,
    }
  );

  assert.deepEqual(
    evaluateChannexAriDispatchEligibility({
      delivery: readyDelivery({
        status: "PROCESSING",
        attemptCount: 1,
        nextAttemptAt: null,
        leaseToken: "lease-1",
        leaseExpiresAt: new Date("2026-07-28T11:59:59.999Z"),
      }),
      now: NOW,
    }),
    {
      eligible: false,
      reason: "STALE_LEASE",
      nextEligibleAt: NOW,
    }
  );
});

test("a stale final-attempt lease remains recoverable before becoming DEAD", () => {
  const delivery = readyDelivery({
    status: "PROCESSING",
    attemptCount: CHANNEX_ARI_MAX_ATTEMPTS,
    nextAttemptAt: null,
    leaseToken: "lease-final",
    leaseExpiresAt: new Date("2026-07-28T11:59:59.999Z"),
  });

  assert.deepEqual(
    evaluateChannexAriDispatchEligibility({
      delivery,
      now: NOW,
    }),
    {
      eligible: false,
      reason: "STALE_LEASE",
      nextEligibleAt: NOW,
    }
  );

  const recovery = buildChannexAriStaleLeaseRecovery({
    delivery,
    now: NOW,
  });

  assert.equal(recovery.exhausted, true);
  assert.equal(recovery.retryDelayMs, null);
  assert.equal(recovery.deliveryUpdate.status, "DEAD");
  assert.deepEqual(recovery.deliveryUpdate.deadAt, NOW);
  assert.equal(
    recovery.deliveryUpdate.lastErrorCode,
    "CHANNEX_ARI_LEASE_EXPIRED_AFTER_MAX_ATTEMPTS"
  );
  assert.equal(recovery.attemptUpdate.outcome, "UNKNOWN_AFTER_LEASE");
  assert.deepEqual(
    recovery.propertyStateUpdate.pausedUntil,
    new Date(NOW.getTime() + CHANNEX_ARI_MIN_RATE_LIMIT_PAUSE_MS)
  );
});

test("builds an atomic claim contract with the default lease and same-kind spacing", () => {
  const claim = buildChannexAriDispatchClaim({
    delivery: readyDelivery(),
    propertyState: {},
    now: NOW,
    leaseToken: " lease-1 ",
  });

  assert.equal(claim.attemptNumber, 1);
  assert.equal(claim.leaseMs, CHANNEX_ARI_DEFAULT_LEASE_MS);
  assert.deepEqual(claim.deliveryUpdate, {
    status: "PROCESSING",
    attemptCount: 1,
    nextAttemptAt: null,
    leaseToken: "lease-1",
    leaseExpiresAt: new Date(NOW.getTime() + CHANNEX_ARI_DEFAULT_LEASE_MS),
    processingStartedAt: NOW,
  });
  assert.deepEqual(claim.attemptCreate, {
    attemptNumber: 1,
    outcome: "IN_FLIGHT",
    startedAt: NOW,
  });
  assert.deepEqual(claim.propertyStateUpdate, {
    availabilityNextAllowedAt: new Date(
      NOW.getTime() + CHANNEX_ARI_MIN_SAME_KIND_SPACING_MS
    ),
  });
});

test("updates only the Rates & Restrictions throttle when claiming that message kind", () => {
  const claim = buildChannexAriDispatchClaim({
    delivery: readyDelivery({ messageKind: "RATES_RESTRICTIONS" }),
    now: NOW,
    leaseToken: "lease-rates",
    leaseMs: CHANNEX_ARI_MIN_LEASE_MS,
  });

  assert.deepEqual(claim.propertyStateUpdate, {
    ratesNextAllowedAt: new Date(
      NOW.getTime() + CHANNEX_ARI_MIN_SAME_KIND_SPACING_MS
    ),
  });
  assert.deepEqual(
    claim.deliveryUpdate.leaseExpiresAt,
    new Date(NOW.getTime() + CHANNEX_ARI_MIN_LEASE_MS)
  );
});

test("rejects invalid lease identity, duration and ineligible claims", () => {
  assert.throws(
    () =>
      buildChannexAriDispatchClaim({
        delivery: readyDelivery(),
        now: NOW,
        leaseToken: " ",
      }),
    /CHANNEX_ARI_LEASE_TOKEN_REQUIRED/
  );

  for (const leaseMs of [
    CHANNEX_ARI_MIN_LEASE_MS - 1,
    CHANNEX_ARI_MAX_LEASE_MS + 1,
    30_000.5,
  ]) {
    assert.throws(
      () =>
        buildChannexAriDispatchClaim({
          delivery: readyDelivery(),
          now: NOW,
          leaseToken: "lease-1",
          leaseMs,
        }),
      /CHANNEX_ARI_LEASE_MS_INVALID/
    );
  }

  assert.throws(
    () =>
      buildChannexAriDispatchClaim({
        delivery: readyDelivery({
          nextAttemptAt: new Date("2026-07-28T12:01:00.000Z"),
        }),
        now: NOW,
        leaseToken: "lease-1",
      }),
    /CHANNEX_ARI_DISPATCH_NOT_ELIGIBLE:NEXT_ATTEMPT_PENDING/
  );
});

test("enforces a minimum one-minute property pause and honors longer Retry-After", () => {
  const minimumPause = buildChannexAriPropertyPause({ now: NOW });
  assert.equal(minimumPause.pauseMs, CHANNEX_ARI_MIN_RATE_LIMIT_PAUSE_MS);
  assert.deepEqual(
    minimumPause.pausedUntil,
    new Date(NOW.getTime() + CHANNEX_ARI_MIN_RATE_LIMIT_PAUSE_MS)
  );

  const retryAfterPause = buildChannexAriPropertyPause({
    now: NOW,
    requestedPauseMs: 90_000,
    retryAfterMs: 180_000,
  });
  assert.equal(retryAfterPause.pauseMs, 180_000);
  assert.deepEqual(
    retryAfterPause.pausedUntil,
    new Date(NOW.getTime() + 180_000)
  );
});

test("recovers a stale lease into RETRY_WAIT with UNKNOWN_AFTER_LEASE evidence", () => {
  const recovery = buildChannexAriStaleLeaseRecovery({
    delivery: readyDelivery({
      status: "PROCESSING",
      attemptCount: 2,
      nextAttemptAt: null,
      leaseToken: "lease-2",
      leaseExpiresAt: new Date("2026-07-28T11:59:59.999Z"),
    }),
    now: NOW,
    jitterMs: 1_000,
  });

  assert.equal(recovery.exhausted, false);
  assert.equal(recovery.retryDelayMs, 121_000);
  assert.deepEqual(recovery.deliveryUpdate, {
    status: "RETRY_WAIT",
    nextAttemptAt: new Date(NOW.getTime() + 121_000),
    leaseToken: null,
    leaseExpiresAt: null,
    lastErrorCode: "CHANNEX_ARI_LEASE_EXPIRED",
    lastErrorSummary:
      "Delivery lease expired before the worker persisted a terminal attempt outcome.",
  });
  assert.deepEqual(recovery.attemptUpdate, {
    outcome: "UNKNOWN_AFTER_LEASE",
    completedAt: NOW,
    errorCode: "CHANNEX_ARI_LEASE_EXPIRED",
  });
  assert.deepEqual(
    recovery.propertyStateUpdate.pausedUntil,
    new Date(NOW.getTime() + 121_000)
  );
});

test("rejects stale recovery for a non-processing or still-active lease", () => {
  assert.throws(
    () =>
      buildChannexAriStaleLeaseRecovery({
        delivery: readyDelivery(),
        now: NOW,
      }),
    /CHANNEX_ARI_STALE_RECOVERY_PROCESSING_REQUIRED/
  );

  assert.throws(
    () =>
      buildChannexAriStaleLeaseRecovery({
        delivery: readyDelivery({
          status: "PROCESSING",
          attemptCount: 1,
          nextAttemptAt: null,
          leaseToken: "lease-active",
          leaseExpiresAt: new Date("2026-07-28T12:00:00.001Z"),
        }),
        now: NOW,
      }),
    /CHANNEX_ARI_STALE_RECOVERY_LEASE_ACTIVE/
  );
});

test("computes the latest ordinary dispatch blocker", () => {
  const wakeAt = getChannexAriDispatchWakeAt({
    delivery: readyDelivery({
      status: "RETRY_WAIT",
      attemptCount: 1,
      nextAttemptAt: new Date("2026-07-28T12:01:00.000Z"),
    }),
    propertyState: {
      pausedUntil: new Date("2026-07-28T12:02:00.000Z"),
      availabilityNextAllowedAt: new Date("2026-07-28T12:03:00.000Z"),
    },
    now: NOW,
  });

  assert.deepEqual(wakeAt, new Date("2026-07-28T12:03:00.000Z"));
});

test("schedules stale-lease recovery immediately even while network dispatch is paused", () => {
  const wakeAt = getChannexAriDispatchWakeAt({
    delivery: readyDelivery({
      status: "PROCESSING",
      attemptCount: 1,
      nextAttemptAt: null,
      leaseToken: "lease-stale",
      leaseExpiresAt: new Date("2026-07-28T11:59:59.999Z"),
    }),
    propertyState: {
      pausedUntil: new Date("2026-07-28T13:00:00.000Z"),
      availabilityNextAllowedAt: new Date("2026-07-28T13:00:00.000Z"),
    },
    now: NOW,
  });

  assert.deepEqual(wakeAt, NOW);
});

test("never schedules terminal or exhausted non-processing deliveries", () => {
  for (const delivery of [
    readyDelivery({ status: "SENT" }),
    readyDelivery({ status: "DEAD" }),
    readyDelivery({ status: "SUPERSEDED" }),
    readyDelivery({ attemptCount: CHANNEX_ARI_MAX_ATTEMPTS }),
  ]) {
    assert.equal(
      getChannexAriDispatchWakeAt({
        delivery,
        propertyState: {
          pausedUntil: new Date("2026-07-28T13:00:00.000Z"),
          availabilityNextAllowedAt: new Date("2026-07-28T14:00:00.000Z"),
        },
        now: NOW,
      }),
      null
    );
  }
});
