import {
  CHANNEX_ARI_MAX_ATTEMPTS,
  CHANNEX_ARI_MIN_RATE_LIMIT_PAUSE_MS,
  CHANNEX_ARI_MIN_SAME_KIND_SPACING_MS,
  getRetryDelayMs,
  type ChannexAriMessageKind,
} from "./channex-ari-lifecycle.policy";

export const CHANNEX_ARI_DEFAULT_LEASE_MS = 2 * 60 * 1000;
export const CHANNEX_ARI_MIN_LEASE_MS = 30 * 1000;
export const CHANNEX_ARI_MAX_LEASE_MS = 5 * 60 * 1000;

export type ChannexAriDispatchStatus =
  | "READY"
  | "PROCESSING"
  | "RETRY_WAIT"
  | "SENT"
  | "DEAD"
  | "SUPERSEDED";

export type ChannexAriDispatchDelivery = {
  status: ChannexAriDispatchStatus;
  messageKind: ChannexAriMessageKind;
  attemptCount: number;
  nextAttemptAt?: Date | null;
  leaseToken?: string | null;
  leaseExpiresAt?: Date | null;
};

export type ChannexAriDispatchPropertyState = {
  pausedUntil?: Date | null;
  availabilityNextAllowedAt?: Date | null;
  ratesNextAllowedAt?: Date | null;
};

export type ChannexAriDispatchIneligibleReason =
  | "TERMINAL_STATUS"
  | "ATTEMPTS_EXHAUSTED"
  | "ACTIVE_LEASE"
  | "STALE_LEASE"
  | "NEXT_ATTEMPT_PENDING"
  | "PROPERTY_PAUSED"
  | "KIND_THROTTLED";

export type ChannexAriDispatchEligibility =
  | { eligible: true; reason: null; nextEligibleAt: Date | null }
  | {
      eligible: false;
      reason: ChannexAriDispatchIneligibleReason;
      nextEligibleAt: Date | null;
    };

type NormalizedDelivery = {
  status: ChannexAriDispatchStatus;
  messageKind: ChannexAriMessageKind;
  attemptCount: number;
  nextAttemptAt: Date | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
};

type NormalizedPropertyState = {
  pausedUntil: Date | null;
  availabilityNextAllowedAt: Date | null;
  ratesNextAllowedAt: Date | null;
};

function assertValidDate(value: Date, errorCode: string): Date {
  const normalized = new Date(value);

  if (Number.isNaN(normalized.getTime())) {
    throw new Error(errorCode);
  }

  return normalized;
}

function normalizeOptionalDate(
  value: Date | null | undefined,
  errorCode: string
): Date | null {
  return value == null ? null : assertValidDate(value, errorCode);
}

function requireText(value: unknown, errorCode: string): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(errorCode);
  }

  return normalized;
}

function assertMessageKind(
  value: ChannexAriMessageKind
): ChannexAriMessageKind {
  if (value !== "AVAILABILITY" && value !== "RATES_RESTRICTIONS") {
    throw new Error("CHANNEX_ARI_INVALID_MESSAGE_KIND");
  }

  return value;
}

function assertStatus(value: ChannexAriDispatchStatus): ChannexAriDispatchStatus {
  if (
    value !== "READY" &&
    value !== "PROCESSING" &&
    value !== "RETRY_WAIT" &&
    value !== "SENT" &&
    value !== "DEAD" &&
    value !== "SUPERSEDED"
  ) {
    throw new Error("CHANNEX_ARI_DISPATCH_STATUS_INVALID");
  }

  return value;
}

function assertAttemptCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("CHANNEX_ARI_ATTEMPT_COUNT_INVALID");
  }

  return value;
}

function normalizeDelivery(
  delivery: ChannexAriDispatchDelivery
): NormalizedDelivery {
  const status = assertStatus(delivery.status);
  const messageKind = assertMessageKind(delivery.messageKind);
  const attemptCount = assertAttemptCount(delivery.attemptCount);
  const nextAttemptAt = normalizeOptionalDate(
    delivery.nextAttemptAt,
    "CHANNEX_ARI_NEXT_ATTEMPT_AT_INVALID"
  );
  const leaseToken = String(delivery.leaseToken ?? "").trim() || null;
  const leaseExpiresAt = normalizeOptionalDate(
    delivery.leaseExpiresAt,
    "CHANNEX_ARI_LEASE_EXPIRES_AT_INVALID"
  );

  if (Boolean(leaseToken) !== Boolean(leaseExpiresAt)) {
    throw new Error("CHANNEX_ARI_LEASE_IDENTITY_INCOMPLETE");
  }

  if (status === "PROCESSING") {
    if (!leaseToken || !leaseExpiresAt) {
      throw new Error("CHANNEX_ARI_PROCESSING_LEASE_REQUIRED");
    }

    if (attemptCount < 1) {
      throw new Error("CHANNEX_ARI_PROCESSING_ATTEMPT_REQUIRED");
    }
  } else if (leaseToken || leaseExpiresAt) {
    throw new Error("CHANNEX_ARI_NON_PROCESSING_LEASE_NOT_ALLOWED");
  }

  return {
    status,
    messageKind,
    attemptCount,
    nextAttemptAt,
    leaseToken,
    leaseExpiresAt,
  };
}

function normalizePropertyState(
  state: ChannexAriDispatchPropertyState
): NormalizedPropertyState {
  return {
    pausedUntil: normalizeOptionalDate(
      state.pausedUntil,
      "CHANNEX_ARI_PROPERTY_PAUSED_UNTIL_INVALID"
    ),
    availabilityNextAllowedAt: normalizeOptionalDate(
      state.availabilityNextAllowedAt,
      "CHANNEX_ARI_AVAILABILITY_NEXT_ALLOWED_AT_INVALID"
    ),
    ratesNextAllowedAt: normalizeOptionalDate(
      state.ratesNextAllowedAt,
      "CHANNEX_ARI_RATES_NEXT_ALLOWED_AT_INVALID"
    ),
  };
}

function getKindNextAllowedAt(input: {
  messageKind: ChannexAriMessageKind;
  propertyState: NormalizedPropertyState;
}): Date | null {
  return input.messageKind === "AVAILABILITY"
    ? input.propertyState.availabilityNextAllowedAt
    : input.propertyState.ratesNextAllowedAt;
}

function laterDate(left: Date | null, right: Date | null): Date | null {
  if (!left) return right;
  if (!right) return left;
  return left.getTime() >= right.getTime() ? left : right;
}

function assertLeaseMs(value: number | undefined): number {
  const leaseMs =
    value === undefined ? CHANNEX_ARI_DEFAULT_LEASE_MS : Number(value);

  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < CHANNEX_ARI_MIN_LEASE_MS ||
    leaseMs > CHANNEX_ARI_MAX_LEASE_MS
  ) {
    throw new Error("CHANNEX_ARI_LEASE_MS_INVALID");
  }

  return leaseMs;
}

function isTerminalStatus(status: ChannexAriDispatchStatus): boolean {
  return status === "SENT" || status === "DEAD" || status === "SUPERSEDED";
}

export function evaluateChannexAriDispatchEligibility(input: {
  delivery: ChannexAriDispatchDelivery;
  propertyState?: ChannexAriDispatchPropertyState;
  now: Date;
}): ChannexAriDispatchEligibility {
  const now = assertValidDate(input.now, "CHANNEX_ARI_DISPATCH_NOW_INVALID");
  const delivery = normalizeDelivery(input.delivery);
  const propertyState = normalizePropertyState(input.propertyState ?? {});

  if (isTerminalStatus(delivery.status)) {
    return {
      eligible: false,
      reason: "TERMINAL_STATUS",
      nextEligibleAt: null,
    };
  }

  // Lease recovery is lifecycle reconciliation, not a new network dispatch.
  // It must run even when the final permitted attempt owns the stale lease.
  if (delivery.status === "PROCESSING") {
    const leaseExpiresAt = delivery.leaseExpiresAt!;

    return leaseExpiresAt.getTime() > now.getTime()
      ? {
          eligible: false,
          reason: "ACTIVE_LEASE",
          nextEligibleAt: leaseExpiresAt,
        }
      : {
          eligible: false,
          reason: "STALE_LEASE",
          nextEligibleAt: now,
        };
  }

  if (delivery.attemptCount >= CHANNEX_ARI_MAX_ATTEMPTS) {
    return {
      eligible: false,
      reason: "ATTEMPTS_EXHAUSTED",
      nextEligibleAt: null,
    };
  }

  if (
    delivery.nextAttemptAt &&
    delivery.nextAttemptAt.getTime() > now.getTime()
  ) {
    return {
      eligible: false,
      reason: "NEXT_ATTEMPT_PENDING",
      nextEligibleAt: delivery.nextAttemptAt,
    };
  }

  if (
    propertyState.pausedUntil &&
    propertyState.pausedUntil.getTime() > now.getTime()
  ) {
    return {
      eligible: false,
      reason: "PROPERTY_PAUSED",
      nextEligibleAt: propertyState.pausedUntil,
    };
  }

  const kindNextAllowedAt = getKindNextAllowedAt({
    messageKind: delivery.messageKind,
    propertyState,
  });

  if (kindNextAllowedAt && kindNextAllowedAt.getTime() > now.getTime()) {
    return {
      eligible: false,
      reason: "KIND_THROTTLED",
      nextEligibleAt: kindNextAllowedAt,
    };
  }

  return {
    eligible: true,
    reason: null,
    nextEligibleAt: null,
  };
}

export function buildChannexAriDispatchClaim(input: {
  delivery: ChannexAriDispatchDelivery;
  propertyState?: ChannexAriDispatchPropertyState;
  now: Date;
  leaseToken: string;
  leaseMs?: number;
}) {
  const now = assertValidDate(input.now, "CHANNEX_ARI_DISPATCH_NOW_INVALID");
  const delivery = normalizeDelivery(input.delivery);
  const leaseToken = requireText(
    input.leaseToken,
    "CHANNEX_ARI_LEASE_TOKEN_REQUIRED"
  );
  const leaseMs = assertLeaseMs(input.leaseMs);
  const eligibility = evaluateChannexAriDispatchEligibility({
    delivery,
    propertyState: input.propertyState,
    now,
  });

  if (!eligibility.eligible) {
    throw new Error(
      `CHANNEX_ARI_DISPATCH_NOT_ELIGIBLE:${eligibility.reason}`
    );
  }

  const attemptNumber = delivery.attemptCount + 1;

  if (attemptNumber > CHANNEX_ARI_MAX_ATTEMPTS) {
    throw new Error("CHANNEX_ARI_MAX_ATTEMPTS_EXCEEDED");
  }

  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const nextAllowedAt = new Date(
    now.getTime() + CHANNEX_ARI_MIN_SAME_KIND_SPACING_MS
  );
  const propertyStateUpdate =
    delivery.messageKind === "AVAILABILITY"
      ? { availabilityNextAllowedAt: nextAllowedAt }
      : { ratesNextAllowedAt: nextAllowedAt };

  return {
    attemptNumber,
    leaseMs,
    deliveryUpdate: {
      status: "PROCESSING" as const,
      attemptCount: attemptNumber,
      nextAttemptAt: null,
      leaseToken,
      leaseExpiresAt,
      processingStartedAt: now,
    },
    attemptCreate: {
      attemptNumber,
      outcome: "IN_FLIGHT" as const,
      startedAt: now,
    },
    propertyStateUpdate,
  };
}

export function buildChannexAriPropertyPause(input: {
  now: Date;
  requestedPauseMs?: number | null;
  retryAfterMs?: number | null;
}) {
  const now = assertValidDate(input.now, "CHANNEX_ARI_DISPATCH_NOW_INVALID");
  const requestedPauseMs = Number(input.requestedPauseMs ?? 0);
  const retryAfterMs = Number(input.retryAfterMs ?? 0);

  if (
    !Number.isFinite(requestedPauseMs) ||
    requestedPauseMs < 0 ||
    !Number.isFinite(retryAfterMs) ||
    retryAfterMs < 0
  ) {
    throw new Error("CHANNEX_ARI_PROPERTY_PAUSE_MS_INVALID");
  }

  const pauseMs = Math.max(
    CHANNEX_ARI_MIN_RATE_LIMIT_PAUSE_MS,
    requestedPauseMs,
    retryAfterMs
  );

  return {
    pauseMs,
    pausedUntil: new Date(now.getTime() + pauseMs),
  };
}

export function buildChannexAriStaleLeaseRecovery(input: {
  delivery: ChannexAriDispatchDelivery;
  now: Date;
  jitterMs?: number;
}) {
  const now = assertValidDate(input.now, "CHANNEX_ARI_DISPATCH_NOW_INVALID");
  const delivery = normalizeDelivery(input.delivery);

  if (delivery.status !== "PROCESSING") {
    throw new Error("CHANNEX_ARI_STALE_RECOVERY_PROCESSING_REQUIRED");
  }

  if (delivery.leaseExpiresAt!.getTime() > now.getTime()) {
    throw new Error("CHANNEX_ARI_STALE_RECOVERY_LEASE_ACTIVE");
  }

  const exhausted = delivery.attemptCount >= CHANNEX_ARI_MAX_ATTEMPTS;
  const errorCode = exhausted
    ? "CHANNEX_ARI_LEASE_EXPIRED_AFTER_MAX_ATTEMPTS"
    : "CHANNEX_ARI_LEASE_EXPIRED";
  const attemptUpdate = {
    outcome: "UNKNOWN_AFTER_LEASE" as const,
    completedAt: now,
    errorCode,
  };

  if (exhausted) {
    const pause = buildChannexAriPropertyPause({ now });

    return {
      exhausted: true,
      retryDelayMs: null,
      deliveryUpdate: {
        status: "DEAD" as const,
        nextAttemptAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
        deadAt: now,
        lastErrorCode: errorCode,
        lastErrorSummary:
          "Delivery lease expired after the maximum number of attempts.",
      },
      attemptUpdate,
      propertyStateUpdate: {
        pausedUntil: pause.pausedUntil,
      },
    };
  }

  const retryDelayMs = getRetryDelayMs({
    attemptNumber: delivery.attemptCount,
    jitterMs: input.jitterMs,
  });
  const nextAttemptAt = new Date(now.getTime() + retryDelayMs);
  const pause = buildChannexAriPropertyPause({
    now,
    requestedPauseMs: retryDelayMs,
  });

  return {
    exhausted: false,
    retryDelayMs,
    deliveryUpdate: {
      status: "RETRY_WAIT" as const,
      nextAttemptAt,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: errorCode,
      lastErrorSummary:
        "Delivery lease expired before the worker persisted a terminal attempt outcome.",
    },
    attemptUpdate,
    propertyStateUpdate: {
      pausedUntil: pause.pausedUntil,
    },
  };
}

export function getChannexAriDispatchWakeAt(input: {
  delivery: ChannexAriDispatchDelivery;
  propertyState?: ChannexAriDispatchPropertyState;
  now: Date;
}): Date | null {
  const now = assertValidDate(input.now, "CHANNEX_ARI_DISPATCH_NOW_INVALID");
  const delivery = normalizeDelivery(input.delivery);

  if (isTerminalStatus(delivery.status)) return null;

  // Lease reconciliation must not be delayed by network pause or ARI spacing.
  if (delivery.status === "PROCESSING") {
    return delivery.leaseExpiresAt!.getTime() <= now.getTime()
      ? now
      : delivery.leaseExpiresAt;
  }

  if (delivery.attemptCount >= CHANNEX_ARI_MAX_ATTEMPTS) return null;

  const propertyState = normalizePropertyState(input.propertyState ?? {});
  const eligibility = evaluateChannexAriDispatchEligibility({
    delivery,
    propertyState,
    now,
  });

  if (eligibility.eligible) return now;

  const kindNextAllowedAt = getKindNextAllowedAt({
    messageKind: delivery.messageKind,
    propertyState,
  });

  return laterDate(
    eligibility.nextEligibleAt,
    laterDate(propertyState.pausedUntil, kindNextAllowedAt)
  );
}
