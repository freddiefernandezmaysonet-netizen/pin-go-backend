import { getRetryDelayMs } from "./channex-ari-lifecycle.policy";

export const CHANNEX_ARI_OUTBOX_MAX_MATERIALIZATION_ATTEMPTS = 8;
export const CHANNEX_ARI_OUTBOX_DEFAULT_CLAIM_LEASE_MS = 2 * 60_000;
export const CHANNEX_ARI_OUTBOX_MIN_CLAIM_LEASE_MS = 30_000;
export const CHANNEX_ARI_OUTBOX_MAX_CLAIM_LEASE_MS = 5 * 60_000;
export const CHANNEX_ARI_OUTBOX_MAX_ERROR_SUMMARY_LENGTH = 512;
export const CHANNEX_ARI_OUTBOX_MAX_CLAIM_TOKEN_LENGTH = 128;

export type ChannexAriOutboxMaterializationStatus =
  | "PENDING"
  | "CLAIMED"
  | "MERGED"
  | "SUPERSEDED"
  | "DEAD";

export type ChannexAriOutboxMaterializationState = {
  status: ChannexAriOutboxMaterializationStatus;
  materializationAttemptCount: number;
  availableAt: Date;
  claimedAt?: Date | null;
  claimToken?: string | null;
  claimExpiresAt?: Date | null;
  deliveryId?: string | null;
};

function requireText(value: unknown, errorCode: string): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(errorCode);
  }

  return normalized;
}

function assertValidDate(value: unknown, errorCode: string): Date {
  if (value === null || value === undefined || value === "") {
    throw new Error(errorCode);
  }

  const normalized = new Date(value as Date | string | number);

  if (Number.isNaN(normalized.getTime())) {
    throw new Error(errorCode);
  }

  return normalized;
}

function assertAttemptCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("CHANNEX_ARI_OUTBOX_MATERIALIZATION_ATTEMPT_COUNT_INVALID");
  }

  return value;
}

function normalizeLeaseMs(value?: number): number {
  const leaseMs =
    value === undefined
      ? CHANNEX_ARI_OUTBOX_DEFAULT_CLAIM_LEASE_MS
      : Number(value);

  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < CHANNEX_ARI_OUTBOX_MIN_CLAIM_LEASE_MS ||
    leaseMs > CHANNEX_ARI_OUTBOX_MAX_CLAIM_LEASE_MS
  ) {
    throw new Error("CHANNEX_ARI_OUTBOX_CLAIM_LEASE_INVALID");
  }

  return leaseMs;
}

function normalizeClaimToken(value: unknown): string {
  const claimToken = requireText(
    value,
    "CHANNEX_ARI_OUTBOX_MATERIALIZATION_CLAIM_TOKEN_REQUIRED"
  );

  if (
    claimToken.length > CHANNEX_ARI_OUTBOX_MAX_CLAIM_TOKEN_LENGTH ||
    /[\u0000-\u001F\u007F\s]/.test(claimToken)
  ) {
    throw new Error("CHANNEX_ARI_OUTBOX_MATERIALIZATION_CLAIM_TOKEN_INVALID");
  }

  return claimToken;
}

function normalizeErrorCode(value: unknown): string {
  const errorCode = requireText(
    value,
    "CHANNEX_ARI_OUTBOX_MATERIALIZATION_ERROR_CODE_REQUIRED"
  );

  if (!/^[A-Z0-9_]+$/.test(errorCode) || errorCode.length > 128) {
    throw new Error("CHANNEX_ARI_OUTBOX_MATERIALIZATION_ERROR_CODE_INVALID");
  }

  return errorCode;
}

function normalizeErrorSummary(value: unknown): string | null {
  const summary = String(value ?? "").trim();

  if (!summary) return null;

  if (
    summary.length > CHANNEX_ARI_OUTBOX_MAX_ERROR_SUMMARY_LENGTH ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(summary)
  ) {
    throw new Error("CHANNEX_ARI_OUTBOX_MATERIALIZATION_ERROR_SUMMARY_INVALID");
  }

  return summary;
}

function assertUnclaimedPendingState(
  state: ChannexAriOutboxMaterializationState
): void {
  if (state.status !== "PENDING") {
    throw new Error("CHANNEX_ARI_OUTBOX_CLAIM_PENDING_REQUIRED");
  }

  if (state.claimToken || state.claimedAt || state.claimExpiresAt) {
    throw new Error("CHANNEX_ARI_OUTBOX_CLAIM_ALREADY_PRESENT");
  }

  if (state.deliveryId) {
    throw new Error("CHANNEX_ARI_OUTBOX_CLAIM_DELIVERY_PRESENT");
  }
}

function assertMatchingClaim(input: {
  state: ChannexAriOutboxMaterializationState;
  claimToken: string;
}): {
  attemptCount: number;
  availableAt: Date;
  claimedAt: Date;
  claimExpiresAt: Date;
} {
  if (input.state.status !== "CLAIMED") {
    throw new Error("CHANNEX_ARI_OUTBOX_MATERIALIZATION_CLAIMED_REQUIRED");
  }

  const stateToken = normalizeClaimToken(input.state.claimToken);
  const expectedToken = normalizeClaimToken(input.claimToken);

  if (stateToken !== expectedToken) {
    throw new Error("CHANNEX_ARI_OUTBOX_MATERIALIZATION_CLAIM_TOKEN_MISMATCH");
  }

  if (input.state.deliveryId) {
    throw new Error("CHANNEX_ARI_OUTBOX_MATERIALIZATION_DELIVERY_PRESENT");
  }

  const availableAt = assertValidDate(
    input.state.availableAt,
    "CHANNEX_ARI_OUTBOX_AVAILABLE_AT_INVALID"
  );
  const claimedAt = assertValidDate(
    input.state.claimedAt,
    "CHANNEX_ARI_OUTBOX_MATERIALIZATION_CLAIMED_AT_INVALID"
  );
  const claimExpiresAt = assertValidDate(
    input.state.claimExpiresAt,
    "CHANNEX_ARI_OUTBOX_MATERIALIZATION_CLAIM_EXPIRES_AT_INVALID"
  );

  if (claimExpiresAt.getTime() <= claimedAt.getTime()) {
    throw new Error("CHANNEX_ARI_OUTBOX_MATERIALIZATION_CLAIM_WINDOW_INVALID");
  }

  return {
    attemptCount: assertAttemptCount(input.state.materializationAttemptCount),
    availableAt,
    claimedAt,
    claimExpiresAt,
  };
}

export function buildChannexAriOutboxMaterializationClaim(input: {
  state: ChannexAriOutboxMaterializationState;
  claimToken: string;
  claimedAt: Date;
  leaseMs?: number;
}) {
  assertUnclaimedPendingState(input.state);
  const attemptCount = assertAttemptCount(
    input.state.materializationAttemptCount
  );
  const availableAt = assertValidDate(
    input.state.availableAt,
    "CHANNEX_ARI_OUTBOX_AVAILABLE_AT_INVALID"
  );
  const claimedAt = assertValidDate(
    input.claimedAt,
    "CHANNEX_ARI_OUTBOX_CLAIMED_AT_INVALID"
  );
  const claimToken = normalizeClaimToken(input.claimToken);
  const leaseMs = normalizeLeaseMs(input.leaseMs);

  if (availableAt.getTime() > claimedAt.getTime()) {
    throw new Error("CHANNEX_ARI_OUTBOX_EVENT_NOT_READY");
  }

  if (attemptCount >= CHANNEX_ARI_OUTBOX_MAX_MATERIALIZATION_ATTEMPTS) {
    throw new Error("CHANNEX_ARI_OUTBOX_MATERIALIZATION_ATTEMPTS_EXHAUSTED");
  }

  return {
    status: "CLAIMED" as const,
    materializationAttemptCount: attemptCount + 1,
    claimedAt,
    claimToken,
    claimExpiresAt: new Date(claimedAt.getTime() + leaseMs),
    lastErrorCode: null,
    lastErrorSummary: null,
    deadAt: null,
  };
}

export function buildChannexAriOutboxMaterializationFailure(input: {
  state: ChannexAriOutboxMaterializationState;
  claimToken: string;
  failedAt: Date;
  errorCode: string;
  errorSummary?: string | null;
  terminal?: boolean;
  retryAfterMs?: number | null;
  jitterMs?: number;
}) {
  const claim = assertMatchingClaim({
    state: input.state,
    claimToken: input.claimToken,
  });
  const failedAt = assertValidDate(
    input.failedAt,
    "CHANNEX_ARI_OUTBOX_MATERIALIZATION_FAILED_AT_INVALID"
  );
  const errorCode = normalizeErrorCode(input.errorCode);
  const errorSummary = normalizeErrorSummary(input.errorSummary);

  if (failedAt.getTime() < claim.claimedAt.getTime()) {
    throw new Error("CHANNEX_ARI_OUTBOX_MATERIALIZATION_CLOCK_MOVED_BACKWARD");
  }

  if (failedAt.getTime() >= claim.claimExpiresAt.getTime()) {
    throw new Error("CHANNEX_ARI_OUTBOX_MATERIALIZATION_CLAIM_EXPIRED");
  }

  const dead =
    Boolean(input.terminal) ||
    claim.attemptCount >= CHANNEX_ARI_OUTBOX_MAX_MATERIALIZATION_ATTEMPTS;

  if (dead) {
    return {
      status: "DEAD" as const,
      availableAt: claim.availableAt,
      claimedAt: null,
      claimToken: null,
      claimExpiresAt: null,
      lastErrorCode: errorCode,
      lastErrorSummary: errorSummary,
      deadAt: failedAt,
    };
  }

  const delayMs = getRetryDelayMs({
    attemptNumber: claim.attemptCount,
    retryAfterMs: input.retryAfterMs,
    jitterMs: input.jitterMs,
  });

  return {
    status: "PENDING" as const,
    availableAt: new Date(failedAt.getTime() + delayMs),
    claimedAt: null,
    claimToken: null,
    claimExpiresAt: null,
    lastErrorCode: errorCode,
    lastErrorSummary: errorSummary,
    deadAt: null,
  };
}

export function buildChannexAriOutboxStaleClaimRecovery(input: {
  state: ChannexAriOutboxMaterializationState;
  recoveredAt: Date;
  jitterMs?: number;
}) {
  if (input.state.status !== "CLAIMED") {
    throw new Error("CHANNEX_ARI_OUTBOX_STALE_CLAIMED_REQUIRED");
  }

  const attemptCount = assertAttemptCount(
    input.state.materializationAttemptCount
  );
  normalizeClaimToken(input.state.claimToken);
  const availableAt = assertValidDate(
    input.state.availableAt,
    "CHANNEX_ARI_OUTBOX_AVAILABLE_AT_INVALID"
  );
  const claimedAt = assertValidDate(
    input.state.claimedAt,
    "CHANNEX_ARI_OUTBOX_STALE_CLAIMED_AT_INVALID"
  );
  const claimExpiresAt = assertValidDate(
    input.state.claimExpiresAt,
    "CHANNEX_ARI_OUTBOX_STALE_CLAIM_EXPIRES_AT_INVALID"
  );
  const recoveredAt = assertValidDate(
    input.recoveredAt,
    "CHANNEX_ARI_OUTBOX_STALE_RECOVERED_AT_INVALID"
  );

  if (input.state.deliveryId) {
    throw new Error("CHANNEX_ARI_OUTBOX_STALE_DELIVERY_PRESENT");
  }

  if (claimExpiresAt.getTime() <= claimedAt.getTime()) {
    throw new Error("CHANNEX_ARI_OUTBOX_STALE_CLAIM_WINDOW_INVALID");
  }

  if (claimExpiresAt.getTime() > recoveredAt.getTime()) {
    throw new Error("CHANNEX_ARI_OUTBOX_CLAIM_NOT_STALE");
  }

  if (attemptCount >= CHANNEX_ARI_OUTBOX_MAX_MATERIALIZATION_ATTEMPTS) {
    return {
      status: "DEAD" as const,
      availableAt,
      claimedAt: null,
      claimToken: null,
      claimExpiresAt: null,
      lastErrorCode: "CHANNEX_ARI_OUTBOX_CLAIM_STALE",
      lastErrorSummary: null,
      deadAt: recoveredAt,
    };
  }

  const delayMs = getRetryDelayMs({
    attemptNumber: Math.max(1, attemptCount),
    jitterMs: input.jitterMs,
  });

  return {
    status: "PENDING" as const,
    availableAt: new Date(recoveredAt.getTime() + delayMs),
    claimedAt: null,
    claimToken: null,
    claimExpiresAt: null,
    lastErrorCode: "CHANNEX_ARI_OUTBOX_CLAIM_STALE",
    lastErrorSummary: null,
    deadAt: null,
  };
}
