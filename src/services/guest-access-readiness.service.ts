import {
  GuestAccessMode,
  GuestAccessReleaseStatus,
  PaymentState,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";

export type GuestAccessBlocker =
  | "RESERVATION_NOT_ACTIVE"
  | "STAY_ALREADY_ENDED"
  | "PAYMENT_NOT_PAID"
  | "GUEST_IDENTITY_NOT_VERIFIED"
  | "GUEST_AGREEMENT_SNAPSHOT_MISSING"
  | "GUEST_AGREEMENT_NOT_SIGNED"
  | "GUEST_AGREEMENT_ACCEPTANCE_MISSING"
  | "PROPERTY_RULES_NOT_ACCEPTED";

export type GuestAccessReadinessResult = {
  ready: boolean;
  reservationId: string;
  reservationNumber: string | null;
  propertyId: string;
  guestAccessMode: GuestAccessMode;
  releaseStatus: GuestAccessReleaseStatus;
  checkIn: Date;
  checkOut: Date;
  blockers: GuestAccessBlocker[];
};

export async function evaluateGuestAccessReadiness(
  prisma: PrismaClient,
  reservationId: string,
  options?: {
    persist?: boolean;
    now?: Date;
    expectedScope?: {
      organizationId: string;
      propertyId: string;
    };
  }
): Promise<GuestAccessReadinessResult> {
  const now = options?.now ?? new Date();
  const persist = options?.persist ?? true;

  const reservation = await prisma.reservation.findUnique({
    where: {
      id: reservationId,
    },
    select: {
      id: true,
      reservationNumber: true,
      propertyId: true,
      status: true,
      paymentState: true,
      checkIn: true,
      checkOut: true,

      verificationStatus: true,
      verifiedAt: true,
      verificationAcceptedRulesAt: true,

      guestAgreementSnapshot: true,
      guestAgreementAcceptance: true,
      guestAgreementSignedAt: true,

      guestAccessModeSnapshot: true,
      guestAccessReleaseStatus: true,
      guestAccessEligibleAt: true,
      property: {
        select: {
          organizationId: true,
        },
      },
    },
  });

  if (!reservation) {
    throw new Error("GUEST_ACCESS_RESERVATION_NOT_FOUND");
  }

  if (
    options?.expectedScope &&
    (
      reservation.propertyId !==
        options.expectedScope.propertyId ||
      reservation.property.organizationId !==
        options.expectedScope.organizationId
    )
  ) {
    throw new Error(
      "GUEST_ACCESS_EVALUATION_SCOPE_MISMATCH"
    );
  }

  const blockers: GuestAccessBlocker[] = [];

  if (reservation.status !== ReservationStatus.ACTIVE) {
    blockers.push("RESERVATION_NOT_ACTIVE");
  }

  if (reservation.checkOut.getTime() <= now.getTime()) {
    blockers.push("STAY_ALREADY_ENDED");
  }

  if (reservation.paymentState !== PaymentState.PAID) {
    blockers.push("PAYMENT_NOT_PAID");
  }

  const agreementSnapshot =
    reservation.guestAgreementSnapshot &&
    typeof reservation.guestAgreementSnapshot === "object" &&
    !Array.isArray(reservation.guestAgreementSnapshot)
      ? (reservation.guestAgreementSnapshot as Record<string, unknown>)
      : null;
  const requiresIdentityVerification =
    agreementSnapshot?.requiresIdentityVerification !== false;
  const identityRequirementSatisfied = requiresIdentityVerification
    ? reservation.verificationStatus === "COMPLETED" &&
      Boolean(reservation.verifiedAt)
    : reservation.verificationStatus === "NOT_REQUIRED";

  if (!identityRequirementSatisfied) {
    blockers.push("GUEST_IDENTITY_NOT_VERIFIED");
  }

  if (!reservation.guestAgreementSnapshot) {
    blockers.push("GUEST_AGREEMENT_SNAPSHOT_MISSING");
  }

  if (!reservation.guestAgreementSignedAt) {
    blockers.push("GUEST_AGREEMENT_NOT_SIGNED");
  }

  if (!reservation.guestAgreementAcceptance) {
    blockers.push("GUEST_AGREEMENT_ACCEPTANCE_MISSING");
  }

  if (!reservation.verificationAcceptedRulesAt) {
    blockers.push("PROPERTY_RULES_NOT_ACCEPTED");
  }

  const ready = blockers.length === 0;

  const releaseStatus = ready
    ? reservation.guestAccessReleaseStatus ===
      GuestAccessReleaseStatus.RELEASED
      ? GuestAccessReleaseStatus.RELEASED
      : GuestAccessReleaseStatus.ELIGIBLE
    : GuestAccessReleaseStatus.BLOCKED;

  if (persist) {
    const data = {
      guestAccessReleaseStatus: releaseStatus,
      guestAccessEligibleAt: ready
        ? reservation.guestAccessEligibleAt ?? now
        : null,
      guestAccessReleaseLastError: ready
        ? null
        : blockers.join(","),
    };

    if (options?.expectedScope) {
      const persisted =
        await prisma.reservation.updateMany({
          where: {
            id: reservation.id,
            propertyId:
              options.expectedScope.propertyId,
            property: {
              organizationId:
                options.expectedScope.organizationId,
            },
          },
          data,
        });

      if (persisted.count !== 1) {
        throw new Error(
          "GUEST_ACCESS_EVALUATION_SCOPE_CHANGED"
        );
      }
    } else {
      await prisma.reservation.update({
        where: {
          id: reservation.id,
        },
        data,
      });
    }
  }

  return {
    ready,
    reservationId: reservation.id,
    reservationNumber: reservation.reservationNumber,
    propertyId: reservation.propertyId,
    guestAccessMode: reservation.guestAccessModeSnapshot,
    releaseStatus,
    checkIn: reservation.checkIn,
    checkOut: reservation.checkOut,
    blockers,
  };
}

export async function assertGuestAccessReady(
  prisma: PrismaClient,
  reservationId: string,
  options?: {
    now?: Date;
  }
) {
  const result = await evaluateGuestAccessReadiness(
    prisma,
    reservationId,
    {
      persist: true,
      now: options?.now,
    }
  );

  if (!result.ready) {
    throw new Error(
      `GUEST_ACCESS_BLOCKED:${result.blockers.join(",")}`
    );
  }

  return result;
}
