import { createHash } from "node:crypto";

export const GUEST_ACCESS_PROVISION_FENCE_VERSION =
  "guest_access_provision_fence_e14_v1";

export const GUEST_ACCESS_PROVISION_OPERATION = {
  RETRYABLE: "GUEST_ACCESS_PROVISION_RETRYABLE",
  AMBIGUOUS: "GUEST_ACCESS_PROVISION_AMBIGUOUS",
  EXHAUSTED: "GUEST_ACCESS_PROVISION_EXHAUSTED",
} as const;

const CLAIMED_PREFIX = "GUEST_ACCESS_PROVISION_CLAIMED:";
const EXECUTING_PREFIX = "GUEST_ACCESS_PROVISION_EXECUTING:";

export type GuestAccessProvisionFenceState =
  | "IDLE"
  | "RETRYABLE"
  | "CLAIMED"
  | "EXECUTING"
  | "AMBIGUOUS"
  | "EXHAUSTED"
  | "OTHER_OPERATION";

export type GuestAccessProvisionFenceSnapshot = {
  recoveryOperation: string | null;
  recoveryAttemptCount: number;
  recoveryNextAttemptAt: Date | null;
  recoveryExhaustedAt: Date | null;
};

export const GUEST_ACCESS_PROVISION_MAX_ATTEMPTS = 7;
export const GUEST_ACCESS_PROVISION_LEASE_MS = 5 * 60_000;

const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
] as const;

export function fingerprintGuestAccessProvisionLease(
  ownerId: string,
  leaseToken: string
): string {
  return createHash("sha256")
    .update(`${ownerId}:${leaseToken}`)
    .digest("hex");
}

export function buildGuestAccessProvisionClaimedOperation(
  fingerprint: string
): string {
  return `${CLAIMED_PREFIX}${fingerprint}`;
}

export function buildGuestAccessProvisionExecutingOperation(
  fingerprint: string
): string {
  return `${EXECUTING_PREFIX}${fingerprint}`;
}

export function parseGuestAccessProvisionFenceState(
  operation: string | null
): GuestAccessProvisionFenceState {
  if (!operation) return "IDLE";
  if (operation === GUEST_ACCESS_PROVISION_OPERATION.RETRYABLE) {
    return "RETRYABLE";
  }
  if (operation.startsWith(CLAIMED_PREFIX)) return "CLAIMED";
  if (operation.startsWith(EXECUTING_PREFIX)) return "EXECUTING";
  if (operation === GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS) {
    return "AMBIGUOUS";
  }
  if (operation === GUEST_ACCESS_PROVISION_OPERATION.EXHAUSTED) {
    return "EXHAUSTED";
  }
  return "OTHER_OPERATION";
}

export function isGuestAccessProvisionOperation(
  operation: string | null
): boolean {
  return parseGuestAccessProvisionFenceState(operation) !==
    "OTHER_OPERATION";
}

export function isGuestAccessProvisionClaimDue(
  snapshot: GuestAccessProvisionFenceSnapshot,
  now: Date
): boolean {
  const state = parseGuestAccessProvisionFenceState(
    snapshot.recoveryOperation
  );

  if (snapshot.recoveryExhaustedAt) return false;
  if (state === "IDLE") return true;
  if (state !== "RETRYABLE") return false;

  return (
    !snapshot.recoveryNextAttemptAt ||
    snapshot.recoveryNextAttemptAt.getTime() <= now.getTime()
  );
}

export function calculateGuestAccessProvisionRetryAt(
  attemptCount: number,
  now: Date
): Date | null {
  const delay = RETRY_DELAYS_MS[attemptCount - 1];
  return delay === undefined
    ? null
    : new Date(now.getTime() + delay);
}

export function isGuestAccessProvisionLeaseFresh(
  leaseExpiresAt: Date | null,
  now: Date
): boolean {
  return Boolean(
    leaseExpiresAt &&
      leaseExpiresAt.getTime() > now.getTime()
  );
}

export function classifyGuestAccessProviderFailure(
  error: unknown
): "AMBIGUOUS" | "RETRYABLE" {
  const value = (
    error instanceof Error
      ? error.message
      : String(error ?? "")
  )
    .trim()
    .toUpperCase();

  // Once the physical boundary has started, an unknown failure is unsafe to
  // replay. Only an explicitly classified pre-provider or idempotent failure
  // may consume the bounded retry budget.
  const explicitlyRetryableMarkers = [
    "GUEST_ACCESS_PROVISION_SAFE_TO_RETRY",
    "ACCESS_PROVIDER_SAFE_TO_RETRY",
  ];

  return explicitlyRetryableMarkers.some((marker) =>
    value.includes(marker)
  )
    ? "RETRYABLE"
    : "AMBIGUOUS";
}

export function sanitizeGuestAccessProvisionError(
  error: unknown
): string {
  return (
    error instanceof Error
      ? error.message
      : String(error ?? "UNKNOWN_ERROR")
  )
    .replace(
      /:\/\/[^\s/@:]+:[^\s/@]+@/g,
      "://[REDACTED]@"
    )
    .replace(
      /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
      "$1 [REDACTED]"
    )
    .replace(
      /\b(passcode|password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]"
    )
    .slice(0, 8_000);
}


export function guestAccessProvisionFenceOperationWhere() {
  return {
    OR: [
      {
        recoveryOperation: {
          startsWith: CLAIMED_PREFIX,
        },
      },
      {
        recoveryOperation: {
          startsWith: EXECUTING_PREFIX,
        },
      },
      {
        recoveryOperation: {
          in: [
            GUEST_ACCESS_PROVISION_OPERATION.RETRYABLE,
            GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,
            GUEST_ACCESS_PROVISION_OPERATION.EXHAUSTED,
          ],
        },
      },
    ],
  };
}

export function guestAccessProvisionClaimableWhere(
  now: Date
) {
  return {
    OR: [
      {
        recoveryOperation: null,
        recoveryExhaustedAt: null,
      },
      {
        recoveryOperation:
          GUEST_ACCESS_PROVISION_OPERATION.RETRYABLE,
        recoveryExhaustedAt: null,
        OR: [
          { recoveryNextAttemptAt: null },
          { recoveryNextAttemptAt: { lte: now } },
        ],
      },
    ],
  };
}
