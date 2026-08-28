import {
  beginGuestAccessProvisioningExecution,
  claimGuestAccessProvisioning as claimSingleGrant,
  completeGuestAccessProvisioningFailure,
  completeGuestAccessProvisioningPreBoundaryFailure,
  completeGuestAccessProvisioningSuccess,
  releaseGuestAccessProvisioningForEvidence,
  type ExecuteGuestAccessProvisioningResult,
  type GuestAccessProvisionClaimResult,
  type GuestAccessProvisionDb,
} from "./guest-access-admission-fence.service.e14.js";
import {
  GUEST_ACCESS_PROVISION_OPERATION,
  parseGuestAccessProvisionFenceState,
  sanitizeGuestAccessProvisionError,
} from "./guest-access-admission-fence.policy.e14.js";

type ReservationLockTransactionDb = GuestAccessProvisionDb & {
  $queryRawUnsafe<T = unknown>(
    query: string,
    ...values: unknown[]
  ): Promise<T>;
};

type LockCapableDb = GuestAccessProvisionDb & {
  $transaction<T>(
    operation: (tx: ReservationLockTransactionDb) => Promise<T>
  ): Promise<T>;
};

const singletonSelect = {
  id: true,
  reservationId: true,
  type: true,
  method: true,
  status: true,
  startsAt: true,
  endsAt: true,
  recoveryOperation: true,
  recoveryAttemptCount: true,
  recoveryLastAttemptAt: true,
  recoveryNextAttemptAt: true,
  recoveryExhaustedAt: true,
  lastError: true,
  reservation: {
    select: {
      id: true,
      status: true,
      paymentState: true,
      guestAccessReleaseStatus: true,
      checkIn: true,
      checkOut: true,
    },
  },
} as const;

function sameInstant(left: unknown, right: unknown): boolean {
  return (
    left instanceof Date &&
    right instanceof Date &&
    left.getTime() === right.getTime()
  );
}

function isReservationEligible(grant: any, now: Date): boolean {
  return Boolean(
    grant?.reservation?.status === "ACTIVE" &&
      grant.reservation.paymentState === "PAID" &&
      grant.reservation.guestAccessReleaseStatus === "ELIGIBLE" &&
      grant.reservation.checkOut instanceof Date &&
      grant.reservation.checkOut.getTime() > now.getTime()
  );
}

function isCanonicalReservationGrant(grant: any, now: Date): boolean {
  return Boolean(
    grant?.status === "PENDING" &&
      grant.type === "GUEST" &&
      grant.method === "PASSCODE_TIMEBOUND" &&
      grant.reservation?.id === grant.reservationId &&
      isReservationEligible(grant, now) &&
      sameInstant(grant.startsAt, grant.reservation.checkIn) &&
      sameInstant(grant.endsAt, grant.reservation.checkOut)
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

type ClaimFailureReason = Extract<
  GuestAccessProvisionClaimResult,
  { claimed: false }
>["reason"];

function blockingSiblingReason(sibling: any): ClaimFailureReason | null {
  const state = parseGuestAccessProvisionFenceState(
    sibling?.recoveryOperation ?? null
  );

  if (sibling?.status === "ACTIVE") return "AMBIGUOUS";
  if (sibling?.recoveryExhaustedAt) return "EXHAUSTED";
  if (state === "AMBIGUOUS" || state === "OTHER_OPERATION") {
    return "AMBIGUOUS";
  }
  if (state === "EXHAUSTED") return "EXHAUSTED";
  if (state === "RETRYABLE") return "NOT_DUE";
  if (state === "CLAIMED" || state === "EXECUTING") {
    return "LIVE_LEASE";
  }
  return null;
}

async function validateReservationSingletonBeforeClaim(
  db: GuestAccessProvisionDb,
  input: {
    accessGrantId: string;
    reservationId: string;
    now: Date;
  }
): Promise<GuestAccessProvisionClaimResult | null> {
  const grants = await db.accessGrant.findMany({
    where: {
      reservationId: input.reservationId,
      type: "GUEST",
      method: "PASSCODE_TIMEBOUND",
    },
    select: singletonSelect,
  });

  const target = grants.find(
    (grant: any) => grant.id === input.accessGrantId
  );
  if (!target) return { claimed: false, reason: "NOT_FOUND" };
  if (target.status !== "PENDING") {
    return { claimed: false, reason: "NOT_PENDING" };
  }
  if (target.reservation?.id !== input.reservationId) {
    return { claimed: false, reason: "RESERVATION_MISMATCH" };
  }
  if (!isReservationEligible(target, input.now)) {
    return { claimed: false, reason: "NOT_ELIGIBLE" };
  }

  for (const sibling of grants) {
    if (sibling.id === target.id) continue;
    const reason = blockingSiblingReason(sibling);
    if (reason) return { claimed: false, reason };
  }

  const canonical = grants.filter((grant: any) =>
    isCanonicalReservationGrant(grant, input.now)
  );

  if (canonical.length === 1) {
    return canonical[0]?.id === target.id
      ? null
      : { claimed: false, reason: "NOT_ELIGIBLE" };
  }

  // Cardinality is unsafe. Quarantine the target under CAS; another replica
  // will then observe the reservation-level ambiguity and remain fenced.
  const quarantined = await db.accessGrant.updateMany({
    where: {
      ...compareFenceSnapshot(target),
      reservation: { is: { id: input.reservationId } },
    },
    data: {
      recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,
      recoveryNextAttemptAt: null,
      recoveryExhaustedAt: input.now,
      lastError:
        "GUEST_ACCESS_PROVISION_AMBIGUOUS:RESERVATION_CANONICAL_GRANT_SET_INVALID",
    },
  });

  return {
    claimed: false,
    reason: quarantined.count === 1 ? "AMBIGUOUS" : "CLAIM_RACE",
  };
}

async function withReservationClaimLock<T>(
  db: GuestAccessProvisionDb,
  reservationId: string,
  operation: (lockedDb: GuestAccessProvisionDb) => Promise<T>
): Promise<T | { claimed: false; reason: "NOT_FOUND" }> {
  const lockDb = db as LockCapableDb;
  if (typeof lockDb.$transaction !== "function") {
    throw new Error(
      "GUEST_ACCESS_PROVISION_RESERVATION_TRANSACTION_UNAVAILABLE"
    );
  }

  return lockDb.$transaction(async (tx) => {
    if (typeof tx.$queryRawUnsafe !== "function") {
      throw new Error(
        "GUEST_ACCESS_PROVISION_RESERVATION_LOCK_UNAVAILABLE"
      );
    }

    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT "id" FROM "Reservation" WHERE "id" = $1 FOR UPDATE',
      reservationId
    );
    if (!Array.isArray(rows) || rows.length !== 1) {
      return { claimed: false, reason: "NOT_FOUND" };
    }

    return operation(tx);
  });
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

  return withReservationClaimLock(
    db,
    input.reservationId,
    async (lockedDb) => {
      const singletonBlock =
        await validateReservationSingletonBeforeClaim(lockedDb, {
          accessGrantId: input.accessGrantId,
          reservationId: input.reservationId,
          now,
        });
      if (singletonBlock) return singletonBlock;

      return claimSingleGrant(lockedDb, { ...input, now });
    }
  );
}

async function withPhysicalTimeout<T>(
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

/**
 * E14.1 provider boundary. The Reservation row lock is held only through
 * singleton validation and durable AccessGrant claim. Readiness evaluation
 * and the physical callback run after the transaction has committed.
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
  const claimResult = await claimGuestAccessProvisioning(db, {
    accessGrantId: input.accessGrantId,
    reservationId: input.reservationId,
    ownerId: input.ownerId,
    now,
  });

  if (!claimResult.claimed) {
    return {
      status:
        claimResult.reason === "AMBIGUOUS" ||
        claimResult.reason === "OTHER_OPERATION"
          ? "AMBIGUOUS"
          : claimResult.reason === "EXHAUSTED"
            ? "EXHAUSTED"
            : "CLAIM_NOT_ACQUIRED",
      reason: claimResult.reason,
    };
  }

  const claim = claimResult.claim;
  let readiness: Awaited<ReturnType<typeof input.evaluateReadiness>>;

  try {
    readiness = await input.evaluateReadiness(
      input.reservationId,
      now
    );
  } catch (error) {
    const failure =
      await completeGuestAccessProvisioningPreBoundaryFailure(db, {
        claim,
        error,
        now: new Date(),
      });

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
      await releaseGuestAccessProvisioningForEvidence(db, {
        claim,
        reasonCode:
          "GUEST_ACCESS_PROVISION_WAITING_FOR_CANONICAL_EVIDENCE",
      });

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
    ReturnType<typeof beginGuestAccessProvisioningExecution>
  >;

  try {
    execution = await beginGuestAccessProvisioningExecution(db, {
      claim,
      now: input.now ?? new Date(),
    });
  } catch (error) {
    const failure =
      await completeGuestAccessProvisioningPreBoundaryFailure(db, {
        claim,
        error,
        now: new Date(),
      });

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
      await releaseGuestAccessProvisioningForEvidence(db, {
        claim,
        reasonCode:
          "GUEST_ACCESS_PROVISION_EXECUTION_FENCE_NOT_ACQUIRED",
      });

    return {
      status: "CLAIM_NOT_ACQUIRED",
      reason: released.released
        ? "EXECUTION_FENCE_NOT_ACQUIRED"
        : "EXECUTION_RELEASE_FENCE_LOST",
      attemptCount: claim.attemptCount,
    };
  }

  try {
    const activation = await withPhysicalTimeout(
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
      await completeGuestAccessProvisioningSuccess(db, { claim });

    if (!completed.completed) {
      const evidenceError = new Error(
        "GUEST_ACCESS_PROVISION_DURABLE_SUCCESS_EVIDENCE_INCOMPLETE"
      );
      const failure =
        await completeGuestAccessProvisioningFailure(db, {
          claim,
          error: evidenceError,
          now: new Date(),
        });

      return {
        status: failure.state,
        reason: sanitizeGuestAccessProvisionError(evidenceError),
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
      await completeGuestAccessProvisioningFailure(db, {
        claim,
        error,
        now: new Date(),
      });

    return {
      status: failure.state,
      reason: sanitizeGuestAccessProvisionError(error),
      nextAttemptAt: failure.nextAttemptAt,
      attemptCount: claim.attemptCount,
    };
  }
}
