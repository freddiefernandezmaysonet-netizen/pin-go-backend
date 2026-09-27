import assert from "node:assert/strict";
import test from "node:test";

import {
  TTLOCK_LOCK_LINK_STALE_AFTER_MS,
  evaluateTtlockLockLinkHealth,
} from "./ttlock.lockLinkHealth";

const NOW = new Date("2026-09-27T13:00:00.000Z");

test("reports no gateway before evaluating lock-link freshness", () => {
  const result = evaluateTtlockLockLinkHealth({
    hasGateway: false,
    gatewayOnline: false,
    rssiUpdatedAt: null,
    now: NOW,
  });

  assert.equal(result.state, "NO_GATEWAY");
  assert.equal(result.lockReachable, false);
  assert.equal(result.shouldRetry, true);
});

test("reports gateway offline separately from a stale lock link", () => {
  const result = evaluateTtlockLockLinkHealth({
    hasGateway: true,
    gatewayOnline: false,
    rssiUpdatedAt: new Date(NOW.getTime() - 5 * 60 * 1000),
    now: NOW,
  });

  assert.equal(result.state, "GATEWAY_OFFLINE");
  assert.equal(result.lockReachable, false);
});

test("fresh rssi telemetry means the gateway can currently see the lock", () => {
  const result = evaluateTtlockLockLinkHealth({
    hasGateway: true,
    gatewayOnline: true,
    rssiUpdatedAt: new Date(NOW.getTime() - 9 * 60 * 1000),
    now: NOW,
  });

  assert.equal(result.state, "LOCK_LINK_FRESH");
  assert.equal(result.lockReachable, true);
  assert.equal(result.shouldRetry, false);
});

test("lock link becomes stale after the Pin&Go thirty-minute tolerance", () => {
  const result = evaluateTtlockLockLinkHealth({
    hasGateway: true,
    gatewayOnline: true,
    rssiUpdatedAt: new Date(
      NOW.getTime() - TTLOCK_LOCK_LINK_STALE_AFTER_MS - 1
    ),
    now: NOW,
  });

  assert.equal(result.state, "LOCK_LINK_STALE");
  assert.equal(result.lockReachable, false);
  assert.equal(result.shouldRetry, true);
});

test("missing rssi update time stays unknown instead of claiming the lock is offline", () => {
  const result = evaluateTtlockLockLinkHealth({
    hasGateway: true,
    gatewayOnline: true,
    rssiUpdatedAt: null,
    now: NOW,
  });

  assert.equal(result.state, "LOCK_LINK_UNKNOWN");
  assert.equal(result.lockReachable, null);
  assert.equal(result.shouldRetry, true);
});
