const MINUTE_MS = 60 * 1000;

// TTLock documents that gateways refresh nearby-lock signal telemetry roughly
// every 10 minutes. Pin&Go allows three refresh intervals before declaring the
// lock↔gateway link stale to reduce false positives from delayed telemetry.
export const TTLOCK_LOCK_LINK_EXPECTED_REFRESH_MS = 10 * MINUTE_MS;
export const TTLOCK_LOCK_LINK_STALE_AFTER_MS = 30 * MINUTE_MS;
export const TTLOCK_LOCK_LINK_MAX_FUTURE_SKEW_MS = 5 * MINUTE_MS;

export type TTLockLockLinkHealthState =
  | "NO_GATEWAY"
  | "GATEWAY_OFFLINE"
  | "LOCK_LINK_FRESH"
  | "LOCK_LINK_STALE"
  | "LOCK_LINK_UNKNOWN";

export type TTLockLockLinkHealth = {
  state: TTLockLockLinkHealthState;
  lockReachable: boolean | null;
  shouldRetry: boolean;
  ageMs: number | null;
};

export function evaluateTtlockLockLinkHealth(input: {
  hasGateway: boolean;
  gatewayOnline: boolean;
  rssiUpdatedAt: Date | null;
  now?: Date;
}): TTLockLockLinkHealth {
  const now = input.now ?? new Date();

  if (!input.hasGateway) {
    return {
      state: "NO_GATEWAY",
      lockReachable: false,
      shouldRetry: true,
      ageMs: null,
    };
  }

  if (!input.gatewayOnline) {
    return {
      state: "GATEWAY_OFFLINE",
      lockReachable: false,
      shouldRetry: true,
      ageMs: null,
    };
  }

  if (!input.rssiUpdatedAt) {
    return {
      state: "LOCK_LINK_UNKNOWN",
      lockReachable: null,
      shouldRetry: true,
      ageMs: null,
    };
  }

  const ageMs = now.getTime() - input.rssiUpdatedAt.getTime();

  if (
    !Number.isFinite(ageMs) ||
    ageMs < -TTLOCK_LOCK_LINK_MAX_FUTURE_SKEW_MS
  ) {
    return {
      state: "LOCK_LINK_UNKNOWN",
      lockReachable: null,
      shouldRetry: true,
      ageMs,
    };
  }

  if (ageMs > TTLOCK_LOCK_LINK_STALE_AFTER_MS) {
    return {
      state: "LOCK_LINK_STALE",
      lockReachable: false,
      shouldRetry: true,
      ageMs,
    };
  }

  return {
    state: "LOCK_LINK_FRESH",
    lockReachable: true,
    shouldRetry: false,
    ageMs: Math.max(0, ageMs),
  };
}
