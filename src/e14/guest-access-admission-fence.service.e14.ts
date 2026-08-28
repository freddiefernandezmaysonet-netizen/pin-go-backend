import {
  claimGuestAccessProvisioning as claimSingleGrant,
  executeGuestAccessProvisioningWithFence as executeSingleGrant,
} from "./guest-access-admission-fence.single-grant.e14.js";
import {
  claimGuestAccessProvisioning as claimReservationSingleton,
  executeGuestAccessProvisioningWithFence as executeReservationSingleton,
} from "./guest-access-reservation-singleton-fence.e14.js";
import type {
  ExecuteGuestAccessProvisioningResult,
  GuestAccessProvisionClaimResult,
  GuestAccessProvisionDb,
} from "./guest-access-admission-fence.single-grant.e14.js";

export type {
  ExecuteGuestAccessProvisioningResult,
  GuestAccessProvisionClaim,
  GuestAccessProvisionClaimResult,
  GuestAccessProvisionDb,
  GuestAccessProvisionFenceSnapshotBeforeClaim,
} from "./guest-access-admission-fence.single-grant.e14.js";

export {
  beginGuestAccessProvisioningExecution,
  completeGuestAccessProvisioningFailure,
  completeGuestAccessProvisioningPreBoundaryFailure,
  completeGuestAccessProvisioningSuccess,
  recoverStaleGuestAccessProvisioningFences,
  releaseGuestAccessProvisioningForEvidence,
} from "./guest-access-admission-fence.single-grant.e14.js";

function supportsReservationSingletonFence(
  db: GuestAccessProvisionDb
): boolean {
  return typeof (db as any)?.$transaction === "function";
}

/**
 * Production Prisma clients always take the E14.1 reservation-level path.
 * Legacy isolated unit fakes without transaction support retain the original
 * single-grant implementation so E14's pre-existing contract tests remain
 * stable; the E14.1 suite supplies a transaction-capable multi-replica fake.
 */
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
  if (supportsReservationSingletonFence(db)) {
    return claimReservationSingleton(db, input);
  }

  return claimSingleGrant(db, input);
}

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
  if (supportsReservationSingletonFence(db)) {
    return executeReservationSingleton(db, input);
  }

  return executeSingleGrant(db, input);
}
