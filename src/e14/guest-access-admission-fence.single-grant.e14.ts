import { randomUUID } from "node:crypto";

import {
  GUEST_ACCESS_PROVISION_LEASE_MS,
  GUEST_ACCESS_PROVISION_MAX_ATTEMPTS,
  GUEST_ACCESS_PROVISION_OPERATION,
  buildGuestAccessProvisionClaimedOperation,
  buildGuestAccessProvisionExecutingOperation,
  calculateGuestAccessProvisionRetryAt,
  classifyGuestAccessProviderFailure,
  fingerprintGuestAccessProvisionLease,
  guestAccessProvisionFenceOperationWhere,
  isGuestAccessProvisionClaimDue,
  parseGuestAccessProvisionFenceState,
  sanitizeGuestAccessProvisionError,
} from "./guest-access-admission-fence.policy.e14.js";

export type GuestAccessProvisionDb = {
  accessGrant: {
    findUnique(args: any): Promise<any>;
    findMany(args: any): Promise<any[]>;
    updateMany(args: any): Promise<{ count: number }>;
  };
};

export type GuestAccessProvisionFenceSnapshotBeforeClaim = {
  recoveryOperation: string | null;
  recoveryAttemptCount: number;
  recoveryLastAttemptAt: Date | null;
  recoveryNextAttemptAt: Date | null;
  recoveryExhaustedAt: Date | null;
  lastError: string | null;
};

export type GuestAccessProvisionClaim = {
  accessGrantId: string;
  reservationId: string;
  attemptCount: number;
  previousFence: GuestAccessProvisionFenceSnapshotBeforeClaim;
  ownerId: string;
  leaseToken: string;
  leaseFingerprint: string;
  claimedOperation: string;
  executingOperation: string;
  leaseExpiresAt: Date;
};

export type GuestAccessProvisionClaimResult =
  | {
      claimed: true;
      claim: GuestAccessProvisionClaim;
    }
  | {
      claimed: false;
      reason:
        | "NOT_FOUND"
        | "NOT_PENDING"
        | "RESERVATION_MISMATCH"
        | "NOT_ELIGIBLE"
        | "NOT_DUE"
        | "LIVE_LEASE"
        | "AMBIGUOUS"
        | "EXHAUSTED"
        | "OTHER_OPERATION"
        | "CLAIM_RACE";
    };

const fenceSelect = {
  id: true,
  status: true,
  recoveryOperation: true,
  recoveryAttemptCount: true,
  recoveryLastAttemptAt: true,
  recoveryNextAttemptAt: true,
  recoveryExhaustedAt: true,
  lastError: true,
  ttlockKeyboardPwdId: true,
  secureAccessCode: {
    select: { id: true },
  },
  reservation: {
    select: {
      id: true,
      status: true,
      paymentState: true,
      guestAccessReleaseStatus: true,
      checkOut: true,
    },
  },
} as const;

function isCanonicalAdmissionEligible(
  grant: any,
  now: Date
): boolean {
  return Boolean(
    grant?.status === "PENDING" &&
      grant.reservation?.status === "ACTIVE" &&
      grant.reservation?.paymentState === "PAID" &&
      grant.reservation?.guestAccessReleaseStatus ===
        "ELIGIBLE" &&
      grant.reservation?.checkOut instanceof Date &&
      grant.reservation.checkOut.getTime() > now.getTime()
  );
}

function hasCompleteGuestAccessProvisioningEvidence(
  grant: any
): boolean {
  return Boolean(
    grant?.status === "ACTIVE" &&
      grant.ttlockKeyboardPwdId &&
      grant.secureAccessCode
  );
}

function compareFenceSnapshot(grant: any) {
  return {
    id: grant.id,
    status: grant.status,
    recoveryOperation: grant.recoveryOperation,
    recoveryAttemptCount: grant.recoveryAttemptCount,
    recoveryLastAttemptAt: grant.recoveryLastAttemptAt,
    recoveryNextAttemptAt: grant.recoveryNextAttemptAt,
    recoveryExhaustedAt: grant.recoveryExhaustedAt,
    lastError: grant.lastError,
  };
}

export async function claimGuestAccessProvisioning(
  db: GuestAccessProvisionDb,
  input: {
    accessGrantId: string;
    reservationId: string;
    ownerId: string;
    now?: Date;
    leaseMs?: number;
    maxAttempts?: number;
  }
): Promise<GuestAccessProvisionClaimResult> {
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ??
    GUEST_ACCESS_PROVISION_LEASE_MS;
  const maxAttempts = input.maxAttempts ??
    GUEST_ACCESS_PROVISION_MAX_ATTEMPTS;

  const grant = await db.accessGrant.findUnique({
    where: { id: input.accessGrantId },
    select: fenceSelect,
  });

  if (!grant) return { claimed: false, reason: "NOT_FOUND" };
  if (grant.status !== "PENDING") {
    return { claimed: false, reason: "NOT_PENDING" };
  }
  if (grant.reservation?.id !== input.reservationId) {
    return {
      claimed: false,
      reason: "RESERVATION_MISMATCH",
    };
  }
  if (!isCanonicalAdmissionEligible(grant, now)) {
    return { claimed: false, reason: "NOT_ELIGIBLE" };
  }

  const state = parseGuestAccessProvisionFenceState(
    grant.recoveryOperation
  );

  if (state === "AMBIGUOUS") {
    return { claimed: false, reason: "AMBIGUOUS" };
  }
  if (grant.recoveryExhaustedAt || state === "EXHAUSTED") {
    return { claimed: false, reason: "EXHAUSTED" };
  }
  if (state === "CLAIMED" || state === "EXECUTING") {
    return { claimed: false, reason: "LIVE_LEASE" };
  }
  if (state === "OTHER_OPERATION") {
    return { claimed: false, reason: "OTHER_OPERATION" };
  }
  if (!isGuestAccessProvisionClaimDue(grant, now)) {
    return { claimed: false, reason: "NOT_DUE" };
  }

  if (grant.recoveryAttemptCount >= maxAttempts) {
    const exhausted = await db.accessGrant.updateMany({
      where: compareFenceSnapshot(grant),
      data: {
        recoveryOperation:
          GUEST_ACCESS_PROVISION_OPERATION.EXHAUSTED,
        recoveryNextAttemptAt: null,
        recoveryExhaustedAt: now,
        lastError:
          "GUEST_ACCESS_PROVISION_CLAIM_BUDGET_EXHAUSTED",
      },
    });

    return {
      claimed: false,
      reason:
        exhausted.count === 1
          ? "EXHAUSTED"
          : "CLAIM_RACE",
    };
  }

  const previousFence:
    GuestAccessProvisionFenceSnapshotBeforeClaim = {
      recoveryOperation: grant.recoveryOperation,
      recoveryAttemptCount:
        grant.recoveryAttemptCount,
      recoveryLastAttemptAt:
        grant.recoveryLastAttemptAt,
      recoveryNextAttemptAt:
        grant.recoveryNextAttemptAt,
      recoveryExhaustedAt:
        grant.recoveryExhaustedAt,
      lastError: grant.lastError,
    };

  const leaseToken = randomUUID();
  const leaseFingerprint =
    fingerprintGuestAccessProvisionLease(
      input.ownerId,
      leaseToken
    );
  const claimedOperation =
    buildGuestAccessProvisionClaimedOperation(
      leaseFingerprint
    );
  const executingOperation =
    buildGuestAccessProvisionExecutingOperation(
      leaseFingerprint
    );
  const attemptCount =
    grant.recoveryAttemptCount + 1;
  const leaseExpiresAt = new Date(
    now.getTime() + leaseMs
  );

  const claimed = await db.accessGrant.updateMany({
    where: {
      ...compareFenceSnapshot(grant),
      reservation: {
        is: {
          id: input.reservationId,
          status: "ACTIVE",
          paymentState: "PAID",
          guestAccessReleaseStatus: "ELIGIBLE",
          checkOut: { gt: now },
        },
      },
    },
    data: {
      recoveryOperation: claimedOperation,
      recoveryAttemptCount: attemptCount,
      recoveryLastAttemptAt: now,
      recoveryNextAttemptAt: leaseExpiresAt,
      recoveryExhaustedAt: null,
      lastError: null,
    },
  });

  if (claimed.count !== 1) {
    return { claimed: false, reason: "CLAIM_RACE" };
  }

  return {
    claimed: true,
    claim: {
      accessGrantId: grant.id,
      reservationId: input.reservationId,
      attemptCount,
      previousFence,
      ownerId: input.ownerId,
      leaseToken,
      leaseFingerprint,
      claimedOperation,
      executingOperation,
      leaseExpiresAt,
    },
  };
}

export async function beginGuestAccessProvisioningExecution(
  db: GuestAccessProvisionDb,
  input: {
    claim: GuestAccessProvisionClaim;
    now?: Date;
    executionLeaseMs?: number;
  }
) {
  const now = input.now ?? new Date();
  const executionLeaseMs = input.executionLeaseMs ??
    GUEST_ACCESS_PROVISION_LEASE_MS;
  const leaseExpiresAt = new Date(
    now.getTime() + executionLeaseMs
  );
  const expectedFingerprint =
    fingerprintGuestAccessProvisionLease(
      input.claim.ownerId,
      input.claim.leaseToken
    );
  const expectedClaimedOperation =
    buildGuestAccessProvisionClaimedOperation(
      expectedFingerprint
    );
  const expectedExecutingOperation =
    buildGuestAccessProvisionExecutingOperation(
      expectedFingerprint
    );

  if (
    input.claim.leaseFingerprint !==
      expectedFingerprint ||
    input.claim.claimedOperation !==
      expectedClaimedOperation ||
    input.claim.executingOperation !==
      expectedExecutingOperation
  ) {
    return {
      started: false,
      leaseExpiresAt: null,
    };
  }

  const started = await db.accessGrant.updateMany({
    where: {
      id: input.claim.accessGrantId,
      status: "PENDING",
      recoveryOperation:
        input.claim.claimedOperation,
      recoveryAttemptCount:
        input.claim.attemptCount,
      recoveryNextAttemptAt: { gt: now },
      recoveryExhaustedAt: null,
      reservation: {
        is: {
          id: input.claim.reservationId,
          status: "ACTIVE",
          paymentState: "PAID",
          guestAccessReleaseStatus: "ELIGIBLE",
          checkOut: { gt: now },
        },
      },
    },
    data: {
      recoveryOperation:
        input.claim.executingOperation,
      recoveryNextAttemptAt: leaseExpiresAt,
    },
  });

  return {
    started: started.count === 1,
    leaseExpiresAt:
      started.count === 1
        ? leaseExpiresAt
        : null,
  };
}

export async function releaseGuestAccessProvisioningForEvidence(
  db: GuestAccessProvisionDb,
  input: {
    claim: GuestAccessProvisionClaim;
    reasonCode: string;
  }
) {
  const released = await db.accessGrant.updateMany({
    where: {
      id: input.claim.accessGrantId,
      status: "PENDING",
      recoveryOperation:
        input.claim.claimedOperation,
      recoveryAttemptCount:
        input.claim.attemptCount,
      lastError: null,
    },
    data: {
      // Readiness changed before the physical boundary. Restore the exact
      // pre-claim fence so no provider-attempt budget is consumed.
      recoveryOperation:
        input.claim.previousFence.recoveryOperation,
      recoveryAttemptCount:
        input.claim.previousFence.recoveryAttemptCount,
      recoveryLastAttemptAt:
        input.claim.previousFence.recoveryLastAttemptAt,
      recoveryNextAttemptAt:
        input.claim.previousFence.recoveryNextAttemptAt,
      recoveryExhaustedAt:
        input.claim.previousFence.recoveryExhaustedAt,
      lastError:
        input.claim.previousFence.lastError ??
        input.reasonCode,
    },
  });

  return { released: released.count === 1 };
}

export async function completeGuestAccessProvisioningPreBoundaryFailure(
  db: GuestAccessProvisionDb,
  input: {
    claim: GuestAccessProvisionClaim;
    error: unknown;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  const errorDetail = sanitizeGuestAccessProvisionError(
    input.error
  );
  const nextAttemptAt =
    calculateGuestAccessProvisionRetryAt(
      input.claim.attemptCount,
      now
    );
  const exhausted = !nextAttemptAt;

  const completed = await db.accessGrant.updateMany({
    where: {
      id: input.claim.accessGrantId,
      status: "PENDING",
      recoveryOperation:
        input.claim.claimedOperation,
      recoveryAttemptCount:
        input.claim.attemptCount,
      reservation: {
        is: {
          id: input.claim.reservationId,
        },
      },
    },
    data: {
      recoveryOperation: exhausted
        ? GUEST_ACCESS_PROVISION_OPERATION.EXHAUSTED
        : GUEST_ACCESS_PROVISION_OPERATION.RETRYABLE,
      recoveryNextAttemptAt: nextAttemptAt,
      recoveryExhaustedAt: exhausted ? now : null,
      lastError: exhausted
        ? `GUEST_ACCESS_PROVISION_PRE_BOUNDARY_EXHAUSTED:${errorDetail}`
        : `GUEST_ACCESS_PROVISION_PRE_BOUNDARY_RETRYABLE:${errorDetail}`,
    },
  });

  return {
    applied: completed.count === 1,
    state: exhausted
      ? "EXHAUSTED" as const
      : "RETRYABLE" as const,
    nextAttemptAt,
  };
}

export async function completeGuestAccessProvisioningSuccess(
  db: GuestAccessProvisionDb,
  input: {
    claim: GuestAccessProvisionClaim;
  }
) {
  const evidence = await db.accessGrant.findUnique({
    where: { id: input.claim.accessGrantId },
    select: fenceSelect,
  });

  if (
    !evidence ||
    evidence.reservation?.id !==
      input.claim.reservationId ||
    !hasCompleteGuestAccessProvisioningEvidence(
      evidence
    )
  ) {
    return {
      completed: false,
      fenceCleared: false,
      durableEvidence: false,
    };
  }

  const completed = await db.accessGrant.updateMany({
    where: {
      id: input.claim.accessGrantId,
      status: "ACTIVE",
      recoveryOperation:
        input.claim.executingOperation,
      recoveryAttemptCount:
        input.claim.attemptCount,
      reservation: {
        is: {
          id: input.claim.reservationId,
        },
      },
    },
    data: {
      recoveryOperation: null,
      recoveryAttemptCount: 0,
      recoveryLastAttemptAt: null,
      recoveryNextAttemptAt: null,
      recoveryExhaustedAt: null,
      lastError: null,
    },
  });

  if (completed.count === 1) {
    return {
      completed: true,
      fenceCleared: true,
      durableEvidence: true,
    };
  }

  const latest = await db.accessGrant.findUnique({
    where: { id: input.claim.accessGrantId },
    select: fenceSelect,
  });
  const durableEvidence = Boolean(
    latest?.reservation?.id ===
      input.claim.reservationId &&
      hasCompleteGuestAccessProvisioningEvidence(
        latest
      )
  );

  return {
    completed: durableEvidence,
    fenceCleared:
      durableEvidence &&
      latest?.recoveryOperation === null,
    durableEvidence,
  };
}

export async function completeGuestAccessProvisioningFailure(
  db: GuestAccessProvisionDb,
  input: {
    claim: GuestAccessProvisionClaim;
    error: unknown;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  const errorDetail = sanitizeGuestAccessProvisionError(
    input.error
  );
  const classification =
    classifyGuestAccessProviderFailure(input.error);

  if (classification === "AMBIGUOUS") {
    const quarantined = await db.accessGrant.updateMany({
      where: {
        id: input.claim.accessGrantId,
        recoveryOperation:
          input.claim.executingOperation,
        recoveryAttemptCount:
          input.claim.attemptCount,
      },
      data: {
        recoveryOperation:
          GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,
        recoveryNextAttemptAt: null,
        recoveryExhaustedAt: now,
        lastError:
          `GUEST_ACCESS_PROVISION_AMBIGUOUS:${errorDetail}`,
      },
    });

    return {
      applied: quarantined.count === 1,
      state: "AMBIGUOUS" as const,
      nextAttemptAt: null,
    };
  }

  const nextAttemptAt =
    calculateGuestAccessProvisionRetryAt(
      input.claim.attemptCount,
      now
    );

  if (!nextAttemptAt) {
    const exhausted = await db.accessGrant.updateMany({
      where: {
        id: input.claim.accessGrantId,
        recoveryOperation:
          input.claim.executingOperation,
        recoveryAttemptCount:
          input.claim.attemptCount,
      },
      data: {
        recoveryOperation:
          GUEST_ACCESS_PROVISION_OPERATION.EXHAUSTED,
        recoveryNextAttemptAt: null,
        recoveryExhaustedAt: now,
        lastError:
          `GUEST_ACCESS_PROVISION_EXHAUSTED:${errorDetail}`,
      },
    });

    return {
      applied: exhausted.count === 1,
      state: "EXHAUSTED" as const,
      nextAttemptAt: null,
    };
  }

  const retryable = await db.accessGrant.updateMany({
    where: {
      id: input.claim.accessGrantId,
      status: "PENDING",
      recoveryOperation:
        input.claim.executingOperation,
      recoveryAttemptCount:
        input.claim.attemptCount,
    },
    data: {
      recoveryOperation:
        GUEST_ACCESS_PROVISION_OPERATION.RETRYABLE,
      recoveryNextAttemptAt: nextAttemptAt,
      recoveryExhaustedAt: null,
      lastError:
        `GUEST_ACCESS_PROVISION_RETRYABLE:${errorDetail}`,
    },
  });

  if (retryable.count === 1) {
    return {
      applied: true,
      state: "RETRYABLE" as const,
      nextAttemptAt,
    };
  }

  // The provider path changed local state unexpectedly. Do not replay blindly.
  const quarantined = await db.accessGrant.updateMany({
    where: {
      id: input.claim.accessGrantId,
      recoveryOperation:
        input.claim.executingOperation,
      recoveryAttemptCount:
        input.claim.attemptCount,
    },
    data: {
      recoveryOperation:
        GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,
      recoveryNextAttemptAt: null,
      recoveryExhaustedAt: now,
      lastError:
        "GUEST_ACCESS_PROVISION_AMBIGUOUS:LOCAL_STATE_CHANGED_DURING_PROVIDER_EXECUTION",
    },
  });

  return {
    applied: quarantined.count === 1,
    state: "AMBIGUOUS" as const,
    nextAttemptAt: null,
  };
}

export async function recoverStaleGuestAccessProvisioningFences(
  db: GuestAccessProvisionDb,
  input: {
    now?: Date;
    limit?: number;
  } = {}
) {
  const now = input.now ?? new Date();
  const [activeFenced, stalePending] =
    await Promise.all([
      db.accessGrant.findMany({
        where: {
          // A physical callback may complete after our timeout. Any ACTIVE
          // grant carrying an E14 fence is reconciled from durable evidence.
          status: "ACTIVE",
          ...guestAccessProvisionFenceOperationWhere(),
        },
        take: input.limit ?? 50,
        orderBy: { updatedAt: "asc" },
        select: fenceSelect,
      }),
      db.accessGrant.findMany({
        where: {
          status: "PENDING",
          AND: [
            {
              OR: [
                {
                  recoveryOperation: {
                    startsWith:
                      "GUEST_ACCESS_PROVISION_CLAIMED:",
                  },
                },
                {
                  recoveryOperation: {
                    startsWith:
                      "GUEST_ACCESS_PROVISION_EXECUTING:",
                  },
                },
              ],
            },
            {
              OR: [
                { recoveryNextAttemptAt: null },
                {
                  recoveryNextAttemptAt: {
                    lte: now,
                  },
                },
              ],
            },
          ],
        },
        take: input.limit ?? 50,
        orderBy: { recoveryNextAttemptAt: "asc" },
        select: fenceSelect,
      }),
    ]);

  const stale = [
    ...activeFenced,
    ...stalePending,
  ];

  let retryable = 0;
  let reconciledSuccess = 0;
  let ambiguous = 0;
  let races = 0;

  for (const grant of stale) {
    const state = parseGuestAccessProvisionFenceState(
      grant.recoveryOperation
    );

    if (grant.status === "ACTIVE") {
      const durableSuccess = Boolean(
        grant.ttlockKeyboardPwdId &&
          grant.secureAccessCode
      );

      if (
        !durableSuccess &&
        state === "AMBIGUOUS" &&
        !grant.recoveryNextAttemptAt
      ) {
        // Already quarantined. Preserve evidence without a write loop.
        ambiguous += 1;
        continue;
      }

      const updated = await db.accessGrant.updateMany({
        where: compareFenceSnapshot(grant),
        data: durableSuccess
          ? {
              recoveryOperation: null,
              recoveryAttemptCount: 0,
              recoveryLastAttemptAt: null,
              recoveryNextAttemptAt: null,
              recoveryExhaustedAt: null,
              lastError: null,
            }
          : {
              recoveryOperation:
                GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,
              recoveryNextAttemptAt: null,
              recoveryExhaustedAt: now,
              lastError:
                "GUEST_ACCESS_PROVISION_AMBIGUOUS:ACTIVE_EVIDENCE_INCOMPLETE",
            },
      });

      if (updated.count !== 1) races += 1;
      else if (durableSuccess) reconciledSuccess += 1;
      else ambiguous += 1;
      continue;
    }

    if (state === "CLAIMED") {
      const nextAttemptAt =
        calculateGuestAccessProvisionRetryAt(
          Math.max(1, grant.recoveryAttemptCount),
          now
        );
      const updated = await db.accessGrant.updateMany({
        where: compareFenceSnapshot(grant),
        data: {
          recoveryOperation:
            nextAttemptAt
              ? GUEST_ACCESS_PROVISION_OPERATION.RETRYABLE
              : GUEST_ACCESS_PROVISION_OPERATION.EXHAUSTED,
          recoveryNextAttemptAt: nextAttemptAt,
          recoveryExhaustedAt:
            nextAttemptAt ? null : now,
          lastError:
            "GUEST_ACCESS_PROVISION_CLAIM_LEASE_EXPIRED_BEFORE_EXECUTION",
        },
      });
      if (updated.count === 1) retryable += 1;
      else races += 1;
      continue;
    }

    if (state === "EXECUTING") {
      const updated = await db.accessGrant.updateMany({
        where: compareFenceSnapshot(grant),
        data: {
          recoveryOperation:
            GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,
          recoveryNextAttemptAt: null,
          recoveryExhaustedAt: now,
          lastError:
            "GUEST_ACCESS_PROVISION_AMBIGUOUS:EXECUTION_LEASE_EXPIRED",
        },
      });
      if (updated.count === 1) ambiguous += 1;
      else races += 1;
    }
  }

  return {
    scanned: stale.length,
    retryable,
    reconciledSuccess,
    ambiguous,
    races,
    externalSideEffects: 0 as const,
  };
}

async function withGuestAccessPhysicalTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "GUEST_ACCESS_PROVISION_RESULT_AMBIGUOUS_TIMEOUT"
              )
            ),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type ExecuteGuestAccessProvisioningResult<T> =
  | {
      status: "SUCCEEDED";
      activation: T;
      fenceCleared: boolean;
      attemptCount: number;
    }
  | {
      status:
        | "WAITING_FOR_EVIDENCE"
        | "CLAIM_NOT_ACQUIRED"
        | "RETRYABLE"
        | "AMBIGUOUS"
        | "EXHAUSTED";
      reason: string;
      nextAttemptAt?: Date | null;
      attemptCount?: number;
    };

/**
 * E14 provider boundary. The injected physical callback is unreachable until:
 * 1. durable readiness is ELIGIBLE,
 * 2. one replica wins the CAS claim,
 * 3. fresh readiness is re-evaluated, and
 * 4. the exact owner+token fingerprint transitions CLAIMED -> EXECUTING.
 */
export async function executeGuestAccessProvisioningWithFence<T>(
  db: GuestAccessProvisionDb,
  input: {
    accessGrantId: string;
    reservationId: string;
    ownerId: string;
    now?: Date;
    evaluateReadiness: (
      reservationId: string,
      now: Date
    ) => Promise<{
      ready: boolean;
      blockers?: readonly string[];
    }>;
    executePhysical: () => Promise<T>;
    physicalTimeoutMs?: number;
    isSuccessfulResult?: (value: T) => boolean;
  }
): Promise<ExecuteGuestAccessProvisioningResult<T>> {
  const now = input.now ?? new Date();
  const claimResult = await claimGuestAccessProvisioning(
    db,
    {
      accessGrantId: input.accessGrantId,
      reservationId: input.reservationId,
      ownerId: input.ownerId,
      now,
    }
  );

  if (!claimResult.claimed) {
    return {
      status:
        claimResult.reason === "AMBIGUOUS"
          ? "AMBIGUOUS"
          : claimResult.reason === "EXHAUSTED"
            ? "EXHAUSTED"
            : "CLAIM_NOT_ACQUIRED",
      reason: claimResult.reason,
    };
  }

  const claim = claimResult.claim;

  let readiness: Awaited<
    ReturnType<typeof input.evaluateReadiness>
  >;

  try {
    readiness = await input.evaluateReadiness(
      input.reservationId,
      now
    );
  } catch (error) {
    const failure =
      await completeGuestAccessProvisioningPreBoundaryFailure(
        db,
        {
          claim,
          error,
          now: new Date(),
        }
      );

    return {
      status: failure.applied
        ? failure.state
        : "CLAIM_NOT_ACQUIRED",
      reason: failure.applied
        ? sanitizeGuestAccessProvisionError(error)
        : "PRE_BOUNDARY_FAILURE_FENCE_LOST",
      nextAttemptAt: failure.nextAttemptAt,
      attemptCount: claim.attemptCount,
    };
  }

  if (!readiness.ready) {
    const released =
      await releaseGuestAccessProvisioningForEvidence(
        db,
        {
          claim,
          reasonCode:
            "GUEST_ACCESS_PROVISION_WAITING_FOR_CANONICAL_EVIDENCE",
        }
      );

    return {
      status: released.released
        ? "WAITING_FOR_EVIDENCE"
        : "CLAIM_NOT_ACQUIRED",
      reason: released.released
        ? "CANONICAL_ACCESS_READINESS_NOT_ELIGIBLE"
        : "READINESS_RELEASE_FENCE_LOST",
      attemptCount: claim.attemptCount,
    };
  }

  let execution: Awaited<
    ReturnType<
      typeof beginGuestAccessProvisioningExecution
    >
  >;
  const executionNow = input.now ?? new Date();

  try {
    execution =
      await beginGuestAccessProvisioningExecution(
        db,
        { claim, now: executionNow }
      );
  } catch (error) {
    const failure =
      await completeGuestAccessProvisioningPreBoundaryFailure(
        db,
        {
          claim,
          error,
          now: new Date(),
        }
      );

    return {
      status: failure.applied
        ? failure.state
        : "CLAIM_NOT_ACQUIRED",
      reason: failure.applied
        ? sanitizeGuestAccessProvisionError(error)
        : "PRE_BOUNDARY_FAILURE_FENCE_LOST",
      nextAttemptAt: failure.nextAttemptAt,
      attemptCount: claim.attemptCount,
    };
  }

  if (!execution.started) {
    const released =
      await releaseGuestAccessProvisioningForEvidence(
        db,
        {
          claim,
          reasonCode:
            "GUEST_ACCESS_PROVISION_EXECUTION_FENCE_NOT_ACQUIRED",
        }
      );

    return {
      status: "CLAIM_NOT_ACQUIRED",
      reason: released.released
        ? "EXECUTION_FENCE_NOT_ACQUIRED"
        : "EXECUTION_RELEASE_FENCE_LOST",
      attemptCount: claim.attemptCount,
    };
  }

  try {
    const activation =
      await withGuestAccessPhysicalTimeout(
        input.executePhysical(),
        input.physicalTimeoutMs ?? 30_000
      );
    const successful = input.isSuccessfulResult
      ? input.isSuccessfulResult(activation)
      : (activation as any)?.ok === true;

    if (!successful) {
      throw new Error(
        `GUEST_ACCESS_PROVISION_PHYSICAL_RESULT_NOT_SUCCESSFUL:${
          (activation as any)?.reason ?? "UNKNOWN"
        }`
      );
    }

    const completed =
      await completeGuestAccessProvisioningSuccess(
        db,
        { claim }
      );

    if (!completed.completed) {
      const evidenceError = new Error(
        "GUEST_ACCESS_PROVISION_DURABLE_SUCCESS_EVIDENCE_INCOMPLETE"
      );
      const failure =
        await completeGuestAccessProvisioningFailure(
          db,
          {
            claim,
            error: evidenceError,
            now: new Date(),
          }
        );

      return {
        status: failure.state,
        reason:
          sanitizeGuestAccessProvisionError(
            evidenceError
          ),
        nextAttemptAt: failure.nextAttemptAt,
        attemptCount: claim.attemptCount,
      };
    }

    return {
      status: "SUCCEEDED",
      activation,
      fenceCleared: completed.fenceCleared,
      attemptCount: claim.attemptCount,
    };
  } catch (error) {
    const failure =
      await completeGuestAccessProvisioningFailure(
        db,
        {
          claim,
          error,
          now: new Date(),
        }
      );

    return {
      status: failure.state,
      reason: sanitizeGuestAccessProvisionError(error),
      nextAttemptAt: failure.nextAttemptAt,
      attemptCount: claim.attemptCount,
    };
  }
}
