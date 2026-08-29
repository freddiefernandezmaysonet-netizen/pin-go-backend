import { createHash } from "node:crypto";
import {
  AccessGrantType,
  AccessMethod,
  AccessStatus,
  GuestAccessReleaseStatus,
  GuestJourneyCoordinationIntentStatus,
  PaymentState,
  Prisma,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";

import {
  GUEST_ACCESS_PROVISION_OPERATION,
  parseGuestAccessProvisionFenceState,
} from "../e14/guest-access-admission-fence.policy.e14";
import {
  isGuestJourneyTenantPropertyScope,
  type GuestJourneyTenantPropertyScope,
} from "../services/guest-journey-tenant-property-scope.policy";

export const GUEST_ACCESS_RECONCILIATION_FENCE_E15_1_VERSION =
  "guest_access_reconciliation_reservation_fence_e15_1_v1" as const;

const E15_MARKER_VERSION =
  "guest_access_ambiguity_reconciliation_e15_v1" as const;

const reservationFenceSelect = {
  id: true,
  propertyId: true,
  status: true,
  paymentState: true,
  guestAccessReleaseStatus: true,
  checkIn: true,
  checkOut: true,
  property: {
    select: { organizationId: true },
  },
  accessGrants: {
    where: {
      type: AccessGrantType.GUEST,
      method: AccessMethod.PASSCODE_TIMEBOUND,
    },
    select: {
      id: true,
      lockId: true,
      status: true,
      startsAt: true,
      endsAt: true,
      updatedAt: true,
      recoveryOperation: true,
      recoveryAttemptCount: true,
      recoveryNextAttemptAt: true,
      recoveryExhaustedAt: true,
      ttlockKeyboardPwdId: true,
      ttlockPayload: true,
      lock: { select: { ttlockLockId: true } },
      secureAccessCode: { select: { id: true } },
    },
  },
} as const;

type ReservationFenceSnapshot = Prisma.ReservationGetPayload<{
  select: typeof reservationFenceSelect;
}>;

type ReservationFenceGrant = ReservationFenceSnapshot["accessGrants"][number];

type ExpectedGrantSnapshot = {
  grantId: string;
  reservationId: string;
  organizationId: string;
  propertyId: string;
  startsAt: Date;
  endsAt: Date;
  updatedAt: Date;
  recoveryAttemptCount: number;
  ttlockLockId: number;
};

export type AdoptProviderCredentialE15_1Input = ExpectedGrantSnapshot & {
  now: Date;
  keyboardPwdId: number;
  code: string;
  maskedCode: string;
  encryptedCode: string;
  hashedCode: string;
  payload: Prisma.InputJsonValue;
  guestPhone: string | null;
};

export type RearmAmbiguousGrantE15_1Input = ExpectedGrantSnapshot & {
  now: Date;
  payload: Prisma.InputJsonValue;
};

export type ReconcileAccessIntentE15_1Input = {
  intentId: string;
  reservationId: string;
  organizationId: string;
  propertyId: string;
  claimCount: number;
  updatedAt: Date;
  lastError: string | null;
  controlledRearmEnabled: boolean;
  scope: GuestJourneyTenantPropertyScope;
  now: Date;
};

export type ReconcileAccessIntentE15_1Result =
  | { action: "SUCCEEDED"; grantId: string }
  | { action: "REARMED"; grantId: string }
  | { action: "UNCHANGED"; reason: string };

function sameInstant(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function markerState(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const marker = (payload as Record<string, any>).e15;
  if (!marker || marker.version !== E15_MARKER_VERSION) return null;
  return String(marker.state ?? "") || null;
}

function positiveTtlockLockId(grant: ReservationFenceGrant): number | null {
  const value = Number(grant.lock.ttlockLockId);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isBlockingSibling(grant: ReservationFenceGrant): boolean {
  if (grant.status === AccessStatus.ACTIVE) return true;
  if (grant.recoveryExhaustedAt) return true;
  const state = parseGuestAccessProvisionFenceState(
    grant.recoveryOperation ?? null
  );
  return [
    "RETRYABLE",
    "CLAIMED",
    "EXECUTING",
    "AMBIGUOUS",
    "EXHAUSTED",
    "OTHER_OPERATION",
  ].includes(state);
}

function lifecycleMatches(
  reservation: ReservationFenceSnapshot,
  input: {
    organizationId: string;
    propertyId: string;
    now: Date;
    releaseStatus:
      | typeof GuestAccessReleaseStatus.ELIGIBLE
      | typeof GuestAccessReleaseStatus.RELEASED;
  }
): boolean {
  return (
    reservation.property.organizationId === input.organizationId &&
    reservation.propertyId === input.propertyId &&
    reservation.status === ReservationStatus.ACTIVE &&
    reservation.paymentState === PaymentState.PAID &&
    reservation.guestAccessReleaseStatus === input.releaseStatus &&
    reservation.checkOut.getTime() > input.now.getTime()
  );
}

function findCanonicalPendingTarget(
  reservation: ReservationFenceSnapshot,
  input: ExpectedGrantSnapshot
): ReservationFenceGrant | null {
  const canonical = reservation.accessGrants.filter((grant) =>
    grant.status === AccessStatus.PENDING &&
    sameInstant(grant.startsAt, reservation.checkIn) &&
    sameInstant(grant.endsAt, reservation.checkOut)
  );
  if (canonical.length !== 1 || canonical[0].id !== input.grantId) {
    return null;
  }

  const target = canonical[0];
  if (
    target.recoveryOperation !== GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS ||
    target.recoveryAttemptCount !== input.recoveryAttemptCount ||
    !sameInstant(target.updatedAt, input.updatedAt) ||
    !sameInstant(target.startsAt, input.startsAt) ||
    !sameInstant(target.endsAt, input.endsAt) ||
    positiveTtlockLockId(target) !== input.ttlockLockId
  ) {
    return null;
  }

  for (const sibling of reservation.accessGrants) {
    if (sibling.id === target.id) continue;
    if (isBlockingSibling(sibling)) return null;
  }
  return target;
}

async function withReservationFence<T>(
  prisma: PrismaClient,
  reservationId: string,
  operation: (
    tx: Prisma.TransactionClient,
    reservation: ReservationFenceSnapshot
  ) => Promise<T>
): Promise<T | null> {
  return prisma.$transaction(async (tx) => {
    const reservationRows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT "id" FROM "Reservation" WHERE "id" = $1 FOR UPDATE',
      reservationId
    );
    if (!Array.isArray(reservationRows) || reservationRows.length !== 1) {
      return null;
    }

    await tx.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT "id" FROM "AccessGrant" WHERE "reservationId" = $1 ORDER BY "id" FOR UPDATE',
      reservationId
    );

    const reservation = await tx.reservation.findUnique({
      where: { id: reservationId },
      select: reservationFenceSelect,
    });
    if (!reservation) return null;
    return operation(tx, reservation);
  }, { isolationLevel: "Serializable" });
}

export async function adoptProviderCredentialUnderReservationFenceE15_1(
  prisma: PrismaClient,
  input: AdoptProviderCredentialE15_1Input
): Promise<boolean> {
  const result = await withReservationFence(
    prisma,
    input.reservationId,
    async (tx, reservation) => {
      if (!lifecycleMatches(reservation, {
        organizationId: input.organizationId,
        propertyId: input.propertyId,
        now: input.now,
        releaseStatus: GuestAccessReleaseStatus.ELIGIBLE,
      })) {
        return false;
      }
      const target = findCanonicalPendingTarget(reservation, input);
      if (!target) return false;

      const updated = await tx.accessGrant.updateMany({
        where: {
          id: target.id,
          reservationId: reservation.id,
          status: AccessStatus.PENDING,
          recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,
          recoveryAttemptCount: input.recoveryAttemptCount,
          updatedAt: input.updatedAt,
          startsAt: reservation.checkIn,
          endsAt: reservation.checkOut,
        },
        data: {
          status: AccessStatus.ACTIVE,
          ttlockKeyboardPwdId: input.keyboardPwdId,
          accessCodeMasked: input.maskedCode,
          desiredStartsAt: reservation.checkIn,
          desiredEndsAt: reservation.checkOut,
          lastAppliedAt: input.now,
          recoveryOperation: null,
          recoveryAttemptCount: 0,
          recoveryLastAttemptAt: null,
          recoveryNextAttemptAt: null,
          recoveryExhaustedAt: null,
          lastError: null,
          ttlockPayload: input.payload,
        },
      });
      if (updated.count !== 1) return false;

      await tx.accessCode.upsert({
        where: { accessGrantId: target.id },
        create: {
          accessGrantId: target.id,
          lockId: input.ttlockLockId,
          method: "period",
          keyboardPwdId: String(input.keyboardPwdId),
          startDate: BigInt(reservation.checkIn.getTime()),
          endDate: BigInt(reservation.checkOut.getTime()),
          phone: input.guestPhone,
          accessCodeEnc: input.encryptedCode,
          accessCodeHash: input.hashedCode,
          accessCodeMasked: input.maskedCode,
          expiresAt: reservation.checkOut,
        },
        update: {
          lockId: input.ttlockLockId,
          method: "period",
          keyboardPwdId: String(input.keyboardPwdId),
          startDate: BigInt(reservation.checkIn.getTime()),
          endDate: BigInt(reservation.checkOut.getTime()),
          phone: input.guestPhone,
          accessCodeEnc: input.encryptedCode,
          accessCodeHash: input.hashedCode,
          accessCodeMasked: input.maskedCode,
          expiresAt: reservation.checkOut,
        },
      });

      const released = await tx.reservation.updateMany({
        where: {
          id: reservation.id,
          propertyId: input.propertyId,
          status: ReservationStatus.ACTIVE,
          paymentState: PaymentState.PAID,
          guestAccessReleaseStatus: GuestAccessReleaseStatus.ELIGIBLE,
          checkIn: reservation.checkIn,
          checkOut: reservation.checkOut,
        },
        data: {
          guestAccessReleaseStatus: GuestAccessReleaseStatus.RELEASED,
          guestAccessReleasedAt: input.now,
          guestAccessReleaseLastError: null,
        },
      });
      if (released.count !== 1) {
        throw new Error("GUEST_ACCESS_E15_1_RESERVATION_RELEASE_CAS_LOST");
      }
      return true;
    }
  );
  return result === true;
}

export async function rearmAmbiguousGrantUnderReservationFenceE15_1(
  prisma: PrismaClient,
  input: RearmAmbiguousGrantE15_1Input
): Promise<boolean> {
  const result = await withReservationFence(
    prisma,
    input.reservationId,
    async (tx, reservation) => {
      if (!lifecycleMatches(reservation, {
        organizationId: input.organizationId,
        propertyId: input.propertyId,
        now: input.now,
        releaseStatus: GuestAccessReleaseStatus.ELIGIBLE,
      })) {
        return false;
      }
      const target = findCanonicalPendingTarget(reservation, input);
      if (!target) return false;

      const updated = await tx.accessGrant.updateMany({
        where: {
          id: target.id,
          reservationId: reservation.id,
          status: AccessStatus.PENDING,
          recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,
          recoveryAttemptCount: input.recoveryAttemptCount,
          updatedAt: input.updatedAt,
          startsAt: reservation.checkIn,
          endsAt: reservation.checkOut,
        },
        data: {
          recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.RETRYABLE,
          recoveryNextAttemptAt: input.now,
          recoveryExhaustedAt: null,
          ttlockPayload: input.payload,
        },
      });
      return updated.count === 1;
    }
  );
  return result === true;
}

function intentBindingFingerprint(input: {
  intentId: string;
  grantId: string;
  reservationId: string;
  startsAt: Date;
  endsAt: Date;
  outcome: "SUCCEEDED" | "REARMED";
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      intentId: input.intentId,
      grantId: input.grantId,
      reservationId: input.reservationId,
      startsAt: input.startsAt.toISOString(),
      endsAt: input.endsAt.toISOString(),
      outcome: input.outcome,
    }))
    .digest("hex");
}

export async function reconcileAccessIntentUnderReservationFenceE15_1(
  prisma: PrismaClient,
  input: ReconcileAccessIntentE15_1Input
): Promise<ReconcileAccessIntentE15_1Result> {
  if (!isGuestJourneyTenantPropertyScope(input.scope, {
    organizationId: input.organizationId,
    propertyId: input.propertyId,
  })) {
    return { action: "UNCHANGED", reason: "SCOPE_MISMATCH" };
  }

  const result = await withReservationFence(
    prisma,
    input.reservationId,
    async (tx, reservation) => {
      if (
        reservation.property.organizationId !== input.organizationId ||
        reservation.propertyId !== input.propertyId ||
        reservation.status !== ReservationStatus.ACTIVE ||
        reservation.paymentState !== PaymentState.PAID ||
        reservation.checkOut.getTime() <= input.now.getTime()
      ) {
        return { action: "UNCHANGED", reason: "LIFECYCLE_DRIFT" } as const;
      }

      const intent = await tx.guestJourneyCoordinationIntent.findUnique({
        where: { id: input.intentId },
        select: {
          id: true,
          reservationId: true,
          targetEngine: true,
          intentType: true,
          status: true,
          claimCount: true,
          updatedAt: true,
          lastError: true,
        },
      });
      if (
        !intent ||
        intent.reservationId !== reservation.id ||
        intent.targetEngine !== "ACCESS" ||
        intent.intentType !== "REQUEST_ACCESS_PROVISIONING" ||
        intent.status !== GuestJourneyCoordinationIntentStatus.EXHAUSTED ||
        intent.claimCount !== input.claimCount ||
        !sameInstant(intent.updatedAt, input.updatedAt) ||
        intent.lastError !== input.lastError
      ) {
        return { action: "UNCHANGED", reason: "INTENT_DRIFT" } as const;
      }

      const currentWindow = reservation.accessGrants.filter((grant) =>
        sameInstant(grant.startsAt, reservation.checkIn) &&
        sameInstant(grant.endsAt, reservation.checkOut) &&
        [AccessStatus.PENDING, AccessStatus.ACTIVE].includes(grant.status as never)
      );
      if (currentWindow.length !== 1) {
        return { action: "UNCHANGED", reason: "CANONICAL_CARDINALITY" } as const;
      }
      const grant = currentWindow[0];
      for (const sibling of reservation.accessGrants) {
        if (sibling.id === grant.id) continue;
        if (isBlockingSibling(sibling)) {
          return { action: "UNCHANGED", reason: "SIBLING_FENCE" } as const;
        }
      }

      if (
        reservation.guestAccessReleaseStatus === GuestAccessReleaseStatus.RELEASED &&
        grant.status === AccessStatus.ACTIVE &&
        Boolean(grant.ttlockKeyboardPwdId) &&
        Boolean(grant.secureAccessCode)
      ) {
        const output = intentBindingFingerprint({
          intentId: intent.id,
          grantId: grant.id,
          reservationId: reservation.id,
          startsAt: reservation.checkIn,
          endsAt: reservation.checkOut,
          outcome: "SUCCEEDED",
        });
        const updated = await tx.guestJourneyCoordinationIntent.updateMany({
          where: {
            id: intent.id,
            status: GuestJourneyCoordinationIntentStatus.EXHAUSTED,
            claimCount: intent.claimCount,
            updatedAt: intent.updatedAt,
            lastError: intent.lastError,
          },
          data: {
            status: GuestJourneyCoordinationIntentStatus.SUCCEEDED,
            leaseToken: null,
            claimedAt: null,
            leaseExpiresAt: null,
            nextActionAt: null,
            succeededAt: input.now,
            exhaustedAt: null,
            outcomeEvidenceFingerprint: output,
            lastError: null,
          },
        });
        return updated.count === 1
          ? { action: "SUCCEEDED", grantId: grant.id } as const
          : { action: "UNCHANGED", reason: "INTENT_CAS_LOST" } as const;
      }

      if (
        input.controlledRearmEnabled &&
        reservation.guestAccessReleaseStatus === GuestAccessReleaseStatus.ELIGIBLE &&
        grant.status === AccessStatus.PENDING &&
        grant.recoveryOperation === GUEST_ACCESS_PROVISION_OPERATION.RETRYABLE &&
        markerState(grant.ttlockPayload) === "REARMED"
      ) {
        const binding = intentBindingFingerprint({
          intentId: intent.id,
          grantId: grant.id,
          reservationId: reservation.id,
          startsAt: reservation.checkIn,
          endsAt: reservation.checkOut,
          outcome: "REARMED",
        });
        const updated = await tx.guestJourneyCoordinationIntent.updateMany({
          where: {
            id: intent.id,
            status: GuestJourneyCoordinationIntentStatus.EXHAUSTED,
            claimCount: intent.claimCount,
            updatedAt: intent.updatedAt,
            lastError: intent.lastError,
          },
          data: {
            status: GuestJourneyCoordinationIntentStatus.RETRYABLE,
            leaseToken: null,
            claimedAt: null,
            leaseExpiresAt: null,
            nextActionAt: input.now,
            exhaustedAt: null,
            outcomeEvidenceFingerprint: binding,
            lastError: "E15_REARMED_AFTER_CONFIRMED_PROVIDER_ABSENCE",
          },
        });
        return updated.count === 1
          ? { action: "REARMED", grantId: grant.id } as const
          : { action: "UNCHANGED", reason: "INTENT_CAS_LOST" } as const;
      }

      return { action: "UNCHANGED", reason: "CANONICAL_GRANT_NOT_RECONCILABLE" } as const;
    }
  );

  return result ?? { action: "UNCHANGED", reason: "RESERVATION_NOT_FOUND" };
}
