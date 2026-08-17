import {
  GuestJourneyState,
  Prisma,
  ReservationStatus,
} from "@prisma/client";
import type { AuditEntry } from "../apms/audit-types";
import { persistAuditEntry } from "../apms/audit-persistence.service";

export type EnsureGuestJourneyResult = {
  journeyId: string;
  currentState: GuestJourneyState;
  created: boolean;
  transitioned: boolean;
};

type GuestJourneyTransactionClient = Pick<
  Prisma.TransactionClient,
  | "reservation"
  | "guestJourney"
  | "accessGrant"
  | "nfcAssignment"
  | "apmsAuditEntry"
>;

export async function ensureGuestJourneyForConfirmedReservation(
  tx: GuestJourneyTransactionClient,
  reservationId: string
): Promise<EnsureGuestJourneyResult> {
  const cleanReservationId = reservationId.trim();

  if (!cleanReservationId) {
    throw new Error("reservationId is required");
  }

  const reservation = await tx.reservation.findUnique({
    where: {
      id: cleanReservationId,
    },
    select: {
      id: true,
      status: true,
      propertyId: true,
      property: {
        select: {
          organizationId: true,
        },
      },
    },
  });

  if (!reservation) {
    throw new Error(
      `Cannot create Guest Journey. Reservation ${cleanReservationId} was not found.`
    );
  }

  if (reservation.status !== ReservationStatus.ACTIVE) {
    throw new Error(
      `Cannot create Guest Journey for reservation ${cleanReservationId} with status ${reservation.status}.`
    );
  }

  let created = false;

  let journey = await tx.guestJourney.findUnique({
    where: {
      reservationId: reservation.id,
    },
    select: {
      id: true,
      currentState: true,
    },
  });

  if (!journey) {
    journey = await tx.guestJourney.create({
      data: {
        reservationId: reservation.id,
        currentState: GuestJourneyState.RESERVATION_CONFIRMED,
      },
      select: {
        id: true,
        currentState: true,
      },
    });

    created = true;
  }

  if (
    journey.currentState !==
    GuestJourneyState.RESERVATION_CONFIRMED
  ) {
    return {
      journeyId: journey.id,
      currentState: journey.currentState,
      created,
      transitioned: false,
    };
  }

  const transitionStartedAt = new Date();

  const transitionResult = await tx.guestJourney.updateMany({
    where: {
      id: journey.id,
      currentState:
        GuestJourneyState.RESERVATION_CONFIRMED,
    },
    data: {
      currentState:
        GuestJourneyState.VERIFICATION_PENDING,
      stateChangedAt: transitionStartedAt,
    },
  });

  if (transitionResult.count === 0) {
    const currentJourney =
      await tx.guestJourney.findUniqueOrThrow({
        where: {
          id: journey.id,
        },
        select: {
          id: true,
          currentState: true,
        },
      });

    return {
      journeyId: currentJourney.id,
      currentState: currentJourney.currentState,
      created,
      transitioned: false,
    };
  }

  const transitionCompletedAt = new Date();

  const auditEntry: AuditEntry = {
    engine: "Guest Journey",
    decisionId:
      `guest-journey:${journey.id}:` +
      "reservation-confirmed-to-verification-pending",
    entityType: "RESERVATION",
    entityId: reservation.id,
    eventType: "DECISION_APPLIED",
    status: "SUCCESS",
    severity: "INFO",
    summary:
      "Guest Journey advanced to verification pending.",
    reason:
      "The reservation was confirmed and the guest must complete pre-arrival verification.",
    startedAt: transitionStartedAt,
    completedAt: transitionCompletedAt,
    durationMs:
      transitionCompletedAt.getTime() -
      transitionStartedAt.getTime(),
    decisions: [
      {
        engine: "Guest Journey",
        rule:
          "RESERVATION_CONFIRMED_TO_VERIFICATION_PENDING",
        label:
          "Begin Guest Verification Stage",
        previousValue:
          GuestJourneyState.RESERVATION_CONFIRMED,
        newValue:
          GuestJourneyState.VERIFICATION_PENDING,
        applied: true,
        metadata: {
          journeyId: journey.id,
          reservationId: reservation.id,
        },
      },
    ],
    metadata: {
      journeyId: journey.id,
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      organizationId:
        reservation.property.organizationId,
      fromState:
        GuestJourneyState.RESERVATION_CONFIRMED,
      toState:
        GuestJourneyState.VERIFICATION_PENDING,
    },
  };

  await persistAuditEntry(tx, auditEntry);

  return {
    journeyId: journey.id,
    currentState:
      GuestJourneyState.VERIFICATION_PENDING,
    created,
    transitioned: true,
  };
}

export type CompleteGuestVerificationResult = {
  journeyId: string;
  currentState: GuestJourneyState;
  transitioned: boolean;
};

export async function completeGuestJourneyVerification(
  tx: GuestJourneyTransactionClient,
  reservationId: string
): Promise<CompleteGuestVerificationResult> {
  const cleanReservationId = reservationId.trim();

  if (!cleanReservationId) {
    throw new Error("reservationId is required");
  }

  const reservation = await tx.reservation.findUnique({
    where: {
      id: cleanReservationId,
    },
    select: {
      id: true,
      status: true,
      propertyId: true,
      verificationStatus: true,
      verifiedAt: true,
      guestAgreementSnapshot: true,
      guestAgreementSignedAt: true,
      property: {
        select: {
          organizationId: true,
        },
      },
    },
  });

  if (!reservation) {
    throw new Error(
      `Cannot complete Guest Journey verification. Reservation ${cleanReservationId} was not found.`
    );
  }

  if (reservation.status !== ReservationStatus.ACTIVE) {
    throw new Error(
      `Cannot complete Guest Journey verification for reservation ${cleanReservationId} with status ${reservation.status}.`
    );
  }

  const agreementSnapshot =
    reservation.guestAgreementSnapshot &&
    typeof reservation.guestAgreementSnapshot === "object" &&
    !Array.isArray(reservation.guestAgreementSnapshot)
      ? (reservation.guestAgreementSnapshot as Record<string, unknown>)
      : null;
  const requiresIdentityVerification =
    agreementSnapshot?.requiresIdentityVerification !== false;
  const identityCompleted =
    reservation.verificationStatus === "COMPLETED" &&
    Boolean(reservation.verifiedAt);
  const identityNotRequired =
    !requiresIdentityVerification &&
    reservation.verificationStatus === "NOT_REQUIRED" &&
    Boolean(reservation.guestAgreementSignedAt);

  if (!identityCompleted && !identityNotRequired) {
    throw new Error(
      `Cannot complete Guest Journey verification for reservation ${cleanReservationId} without completed verification evidence.`
    );
  }

  const verificationCompletedAt = identityCompleted
    ? reservation.verifiedAt!
    : reservation.guestAgreementSignedAt!;

  const journey = await tx.guestJourney.findUnique({
    where: {
      reservationId: reservation.id,
    },
    select: {
      id: true,
      currentState: true,
    },
  });

  if (!journey) {
    throw new Error(
      `Cannot complete Guest Journey verification. Journey for reservation ${cleanReservationId} was not found.`
    );
  }

  if (
    journey.currentState === GuestJourneyState.VERIFICATION_COMPLETED ||
    journey.currentState === GuestJourneyState.ACCESS_SCHEDULED ||
    journey.currentState === GuestJourneyState.READY_FOR_ARRIVAL
  ) {
    return {
      journeyId: journey.id,
      currentState: journey.currentState,
      transitioned: false,
    };
  }

  if (
    journey.currentState !== GuestJourneyState.VERIFICATION_PENDING
  ) {
    throw new Error(
      `Invalid Guest Journey transition from ${journey.currentState} to ${GuestJourneyState.VERIFICATION_COMPLETED}.`
    );
  }

  const transitionStartedAt = new Date();

  const transitionResult = await tx.guestJourney.updateMany({
    where: {
      id: journey.id,
      currentState: GuestJourneyState.VERIFICATION_PENDING,
    },
    data: {
      currentState: GuestJourneyState.VERIFICATION_COMPLETED,
      stateChangedAt: transitionStartedAt,
      verificationCompletedAt,
    },
  });

  if (transitionResult.count === 0) {
    const currentJourney =
      await tx.guestJourney.findUniqueOrThrow({
        where: {
          id: journey.id,
        },
        select: {
          id: true,
          currentState: true,
        },
      });

    return {
      journeyId: currentJourney.id,
      currentState: currentJourney.currentState,
      transitioned: false,
    };
  }

  const transitionCompletedAt = new Date();

  const auditEntry: AuditEntry = {
    engine: "Guest Journey",
    decisionId:
      `guest-journey:${journey.id}:` +
      "verification-pending-to-verification-completed",
    entityType: "RESERVATION",
    entityId: reservation.id,
    eventType: "DECISION_APPLIED",
    status: "SUCCESS",
    severity: "INFO",
    summary:
      "Guest Journey advanced to verification completed.",
    reason:
      identityCompleted
        ? "The guest successfully completed the required identity verification."
        : "Identity verification was not required by the reservation agreement snapshot, and the guest completed the required agreements.",
    startedAt: transitionStartedAt,
    completedAt: transitionCompletedAt,
    durationMs:
      transitionCompletedAt.getTime() -
      transitionStartedAt.getTime(),
    decisions: [
      {
        engine: "Guest Journey",
        rule:
          "VERIFICATION_PENDING_TO_VERIFICATION_COMPLETED",
        label: "Complete Guest Verification Stage",
        previousValue:
          GuestJourneyState.VERIFICATION_PENDING,
        newValue:
          GuestJourneyState.VERIFICATION_COMPLETED,
        applied: true,
        metadata: {
          journeyId: journey.id,
          reservationId: reservation.id,
          verifiedAt: reservation.verifiedAt,
          identityVerificationRequired: requiresIdentityVerification,
          identityVerificationStatus: reservation.verificationStatus,
        },
      },
    ],
    metadata: {
      journeyId: journey.id,
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      organizationId:
        reservation.property.organizationId,
      fromState:
        GuestJourneyState.VERIFICATION_PENDING,
      toState:
        GuestJourneyState.VERIFICATION_COMPLETED,
      verifiedAt: reservation.verifiedAt,
      identityVerificationRequired: requiresIdentityVerification,
      identityVerificationStatus: reservation.verificationStatus,
    },
  };

  await persistAuditEntry(tx, auditEntry);

  return {
    journeyId: journey.id,
    currentState:
      GuestJourneyState.VERIFICATION_COMPLETED,
    transitioned: true,
  };
}

export type ScheduleGuestJourneyAccessResult = {
  journeyId: string;
  currentState: GuestJourneyState;
  transitioned: boolean;
};

export async function scheduleGuestJourneyAccess(
  tx: GuestJourneyTransactionClient,
  reservationId: string,
  accessGrantId: string
): Promise<ScheduleGuestJourneyAccessResult> {
  const cleanReservationId = reservationId.trim();
  const cleanAccessGrantId = accessGrantId.trim();

  if (!cleanReservationId) {
    throw new Error("reservationId is required");
  }

  if (!cleanAccessGrantId) {
    throw new Error("accessGrantId is required");
  }

  const reservation = await tx.reservation.findUnique({
    where: {
      id: cleanReservationId,
    },
    select: {
      id: true,
      status: true,
      propertyId: true,
      guestAccessReleaseStatus: true,
      guestAccessReleasedAt: true,
      property: {
        select: {
          organizationId: true,
        },
      },
    },
  });

  if (!reservation) {
    throw new Error(
      `Cannot schedule Guest Journey access. Reservation ${cleanReservationId} was not found.`
    );
  }

  if (reservation.status !== ReservationStatus.ACTIVE) {
    throw new Error(
      `Cannot schedule Guest Journey access for reservation ${cleanReservationId} with status ${reservation.status}.`
    );
  }

  if (
    reservation.guestAccessReleaseStatus !== "RELEASED" ||
    !reservation.guestAccessReleasedAt
  ) {
    throw new Error(
      `Cannot schedule Guest Journey access for reservation ${cleanReservationId} without released access evidence.`
    );
  }

  const accessGrant = await tx.accessGrant.findFirst({
    where: {
      id: cleanAccessGrantId,
      reservationId: reservation.id,
      type: "GUEST",
      method: "PASSCODE_TIMEBOUND",
      status: "ACTIVE",
    },
    select: {
      id: true,
      ttlockKeyboardPwdId: true,
      lastAppliedAt: true,
      startsAt: true,
      endsAt: true,
      secureAccessCode: {
        select: {
          id: true,
          keyboardPwdId: true,
          expiresAt: true,
        },
      },
    },
  });

  if (!accessGrant) {
    throw new Error(
      `Cannot schedule Guest Journey access. Active guest grant ${cleanAccessGrantId} was not found.`
    );
  }

  if (
    !accessGrant.ttlockKeyboardPwdId ||
    !accessGrant.secureAccessCode
  ) {
    throw new Error(
      `Cannot schedule Guest Journey access. Grant ${cleanAccessGrantId} does not contain complete passcode evidence.`
    );
  }

  const journey = await tx.guestJourney.findUnique({
    where: {
      reservationId: reservation.id,
    },
    select: {
      id: true,
      currentState: true,
    },
  });

  if (!journey) {
    throw new Error(
      `Cannot schedule Guest Journey access. Journey for reservation ${cleanReservationId} was not found.`
    );
  }

  if (
    journey.currentState ===
      GuestJourneyState.ACCESS_SCHEDULED ||
    journey.currentState ===
      GuestJourneyState.READY_FOR_ARRIVAL
  ) {
    return {
      journeyId: journey.id,
      currentState: journey.currentState,
      transitioned: false,
    };
  }

  if (
    journey.currentState !==
    GuestJourneyState.VERIFICATION_COMPLETED
  ) {
    throw new Error(
      `Invalid Guest Journey transition from ${journey.currentState} to ${GuestJourneyState.ACCESS_SCHEDULED}.`
    );
  }

  const transitionStartedAt =
    reservation.guestAccessReleasedAt;

  const transitionResult =
    await tx.guestJourney.updateMany({
      where: {
        id: journey.id,
        currentState:
          GuestJourneyState.VERIFICATION_COMPLETED,
      },
      data: {
        currentState:
          GuestJourneyState.ACCESS_SCHEDULED,
        stateChangedAt: transitionStartedAt,
        accessScheduledAt: transitionStartedAt,
      },
    });

  if (transitionResult.count === 0) {
    const currentJourney =
      await tx.guestJourney.findUniqueOrThrow({
        where: {
          id: journey.id,
        },
        select: {
          id: true,
          currentState: true,
        },
      });

    return {
      journeyId: currentJourney.id,
      currentState: currentJourney.currentState,
      transitioned: false,
    };
  }

  const transitionCompletedAt = new Date();

  const auditEntry: AuditEntry = {
    engine: "Guest Journey",
    decisionId:
      `guest-journey:${journey.id}:` +
      "verification-completed-to-access-scheduled",
    entityType: "RESERVATION",
    entityId: reservation.id,
    eventType: "DECISION_APPLIED",
    status: "SUCCESS",
    severity: "INFO",
    summary:
      "Guest Journey advanced to access scheduled.",
    reason:
      "The Access Engine successfully provisioned and persisted the guest passcode.",
    startedAt: transitionStartedAt,
    completedAt: transitionCompletedAt,
    durationMs: Math.max(
      0,
      transitionCompletedAt.getTime() -
        transitionStartedAt.getTime()
    ),
    decisions: [
      {
        engine: "Guest Journey",
        rule:
          "VERIFICATION_COMPLETED_TO_ACCESS_SCHEDULED",
        label: "Confirm Guest Access Scheduling",
        previousValue:
          GuestJourneyState.VERIFICATION_COMPLETED,
        newValue:
          GuestJourneyState.ACCESS_SCHEDULED,
        applied: true,
        metadata: {
          journeyId: journey.id,
          reservationId: reservation.id,
          accessGrantId: accessGrant.id,
          accessCodeId:
            accessGrant.secureAccessCode.id,
          keyboardPwdId:
            accessGrant.ttlockKeyboardPwdId,
        },
      },
    ],
    metadata: {
      journeyId: journey.id,
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      organizationId:
        reservation.property.organizationId,
      accessGrantId: accessGrant.id,
      accessCodeId:
        accessGrant.secureAccessCode.id,
      fromState:
        GuestJourneyState.VERIFICATION_COMPLETED,
      toState:
        GuestJourneyState.ACCESS_SCHEDULED,
      accessScheduledAt:
        reservation.guestAccessReleasedAt,
      grantStartsAt: accessGrant.startsAt,
      grantEndsAt: accessGrant.endsAt,
    },
  };

  await persistAuditEntry(tx, auditEntry);

  return {
    journeyId: journey.id,
    currentState:
      GuestJourneyState.ACCESS_SCHEDULED,
    transitioned: true,
  };
}

export type MarkGuestJourneyReadyForArrivalResult = {
  journeyId: string;
  currentState: GuestJourneyState;
  transitioned: boolean;
};

export async function markGuestJourneyReadyForArrival(
  tx: GuestJourneyTransactionClient,
  reservationId: string,
  accessGrantId: string,
  now: Date = new Date()
): Promise<MarkGuestJourneyReadyForArrivalResult> {
  const cleanReservationId = reservationId.trim();
  const cleanAccessGrantId = accessGrantId.trim();

  if (!cleanReservationId) {
    throw new Error("reservationId is required");
  }

  if (!cleanAccessGrantId) {
    throw new Error("accessGrantId is required");
  }

  const reservation = await tx.reservation.findUnique({
    where: {
      id: cleanReservationId,
    },
    select: {
      id: true,
      status: true,
      propertyId: true,
      checkIn: true,
      checkOut: true,
      guestAccessReleaseStatus: true,
      guestAccessReleasedAt: true,
      property: {
        select: {
          organizationId: true,
        },
      },
    },
  });

  if (!reservation) {
    throw new Error(
      `Cannot mark Guest Journey ready for arrival. Reservation ${cleanReservationId} was not found.`
    );
  }

  if (reservation.status !== ReservationStatus.ACTIVE) {
    throw new Error(
      `Cannot mark Guest Journey ready for arrival for reservation ${cleanReservationId} with status ${reservation.status}.`
    );
  }

  if (
    reservation.guestAccessReleaseStatus !== "RELEASED" ||
    !reservation.guestAccessReleasedAt
  ) {
    throw new Error(
      `Cannot mark Guest Journey ready for arrival for reservation ${cleanReservationId} without released access evidence.`
    );
  }

  const readyWindowOpensAt = new Date(
    reservation.checkIn.getTime() -
      2 * 60 * 60 * 1000
  );

  if (now.getTime() < readyWindowOpensAt.getTime()) {
    throw new Error(
      `Cannot mark Guest Journey ready for arrival before ${readyWindowOpensAt.toISOString()}.`
    );
  }

  if (reservation.checkOut.getTime() <= now.getTime()) {
    throw new Error(
      `Cannot mark Guest Journey ready for arrival after the stay has ended.`
    );
  }

  const accessGrant = await tx.accessGrant.findFirst({
    where: {
      id: cleanAccessGrantId,
      reservationId: reservation.id,
      type: "GUEST",
      method: "PASSCODE_TIMEBOUND",
      status: "ACTIVE",
    },
    select: {
      id: true,
      ttlockKeyboardPwdId: true,
      startsAt: true,
      endsAt: true,
      secureAccessCode: {
        select: {
          id: true,
        },
      },
    },
  });

  if (
    !accessGrant ||
    !accessGrant.ttlockKeyboardPwdId ||
    !accessGrant.secureAccessCode
  ) {
    throw new Error(
      `Cannot mark Guest Journey ready for arrival without complete active access evidence.`
    );
  }

  const journey = await tx.guestJourney.findUnique({
    where: {
      reservationId: reservation.id,
    },
    select: {
      id: true,
      currentState: true,
    },
  });

  if (!journey) {
    throw new Error(
      `Cannot mark Guest Journey ready for arrival. Journey for reservation ${cleanReservationId} was not found.`
    );
  }

  if (
    journey.currentState ===
    GuestJourneyState.READY_FOR_ARRIVAL
  ) {
    return {
      journeyId: journey.id,
      currentState: journey.currentState,
      transitioned: false,
    };
  }

  if (
    journey.currentState !==
    GuestJourneyState.ACCESS_SCHEDULED
  ) {
    throw new Error(
      `Invalid Guest Journey transition from ${journey.currentState} to ${GuestJourneyState.READY_FOR_ARRIVAL}.`
    );
  }

  const transitionStartedAt = now;

  const transitionResult =
    await tx.guestJourney.updateMany({
      where: {
        id: journey.id,
        currentState:
          GuestJourneyState.ACCESS_SCHEDULED,
      },
      data: {
        currentState:
          GuestJourneyState.READY_FOR_ARRIVAL,
        stateChangedAt: transitionStartedAt,
        readyForArrivalAt: transitionStartedAt,
      },
    });

  if (transitionResult.count === 0) {
    const currentJourney =
      await tx.guestJourney.findUniqueOrThrow({
        where: {
          id: journey.id,
        },
        select: {
          id: true,
          currentState: true,
        },
      });

    return {
      journeyId: currentJourney.id,
      currentState: currentJourney.currentState,
      transitioned: false,
    };
  }

  const transitionCompletedAt = new Date();

  const auditEntry: AuditEntry = {
    engine: "Guest Journey",
    decisionId:
      `guest-journey:${journey.id}:` +
      "access-scheduled-to-ready-for-arrival",
    entityType: "RESERVATION",
    entityId: reservation.id,
    eventType: "DECISION_APPLIED",
    status: "SUCCESS",
    severity: "INFO",
    summary:
      "Guest Journey advanced to ready for arrival.",
    reason:
      "The guest access was provisioned and the two-hour arrival readiness window opened.",
    startedAt: transitionStartedAt,
    completedAt: transitionCompletedAt,
    durationMs: Math.max(
      0,
      transitionCompletedAt.getTime() -
        transitionStartedAt.getTime()
    ),
    decisions: [
      {
        engine: "Guest Journey",
        rule:
          "ACCESS_SCHEDULED_TO_READY_FOR_ARRIVAL",
        label:
          "Confirm Guest Ready for Arrival",
        previousValue:
          GuestJourneyState.ACCESS_SCHEDULED,
        newValue:
          GuestJourneyState.READY_FOR_ARRIVAL,
        applied: true,
        metadata: {
          journeyId: journey.id,
          reservationId: reservation.id,
          accessGrantId: accessGrant.id,
          readyWindowOpensAt,
        },
      },
    ],
    metadata: {
      journeyId: journey.id,
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      organizationId:
        reservation.property.organizationId,
      accessGrantId: accessGrant.id,
      accessCodeId:
        accessGrant.secureAccessCode.id,
      fromState:
        GuestJourneyState.ACCESS_SCHEDULED,
      toState:
        GuestJourneyState.READY_FOR_ARRIVAL,
      readyForArrivalAt:
        transitionStartedAt,
      readyWindowOpensAt,
      checkIn: reservation.checkIn,
      checkOut: reservation.checkOut,
    },
  };

  await persistAuditEntry(tx, auditEntry);

  return {
    journeyId: journey.id,
    currentState:
      GuestJourneyState.READY_FOR_ARRIVAL,
    transitioned: true,
  };
}

export type MarkGuestJourneyStayActiveResult = {
  journeyId: string;
  currentState: GuestJourneyState;
  transitioned: boolean;
};

export async function markGuestJourneyStayActive(
  tx: GuestJourneyTransactionClient,
  reservationId: string,
  now: Date = new Date()
): Promise<MarkGuestJourneyStayActiveResult> {
  const cleanReservationId = reservationId.trim();

  if (!cleanReservationId) {
    throw new Error("reservationId is required");
  }

  const reservation = await tx.reservation.findUnique({
    where: {
      id: cleanReservationId,
    },
    select: {
      id: true,
      status: true,
      propertyId: true,
      checkIn: true,
      checkOut: true,
      guestAccessReleaseStatus: true,
      guestAccessReleasedAt: true,
      property: {
        select: {
          organizationId: true,
        },
      },
    },
  });

  if (!reservation) {
    throw new Error(
      `Cannot mark Guest Journey stay active. Reservation ${cleanReservationId} was not found.`
    );
  }

  if (reservation.status !== ReservationStatus.ACTIVE) {
    throw new Error(
      `Cannot mark Guest Journey stay active for reservation ${cleanReservationId} with status ${reservation.status}.`
    );
  }

  if (
    reservation.guestAccessReleaseStatus !== "RELEASED" ||
    !reservation.guestAccessReleasedAt
  ) {
    throw new Error(
      `Cannot mark Guest Journey stay active for reservation ${cleanReservationId} without released access evidence.`
    );
  }

  if (now.getTime() < reservation.checkIn.getTime()) {
    throw new Error(
      `Cannot mark Guest Journey stay active before ${reservation.checkIn.toISOString()}.`
    );
  }

  if (now.getTime() >= reservation.checkOut.getTime()) {
    throw new Error(
      "Cannot mark Guest Journey stay active after the scheduled stay window has ended."
    );
  }

  const journey = await tx.guestJourney.findUnique({
    where: {
      reservationId: reservation.id,
    },
    select: {
      id: true,
      currentState: true,
    },
  });

  if (!journey) {
    throw new Error(
      `Cannot mark Guest Journey stay active. Journey for reservation ${cleanReservationId} was not found.`
    );
  }

  if (
    journey.currentState === GuestJourneyState.STAY_ACTIVE ||
    journey.currentState === GuestJourneyState.CHECKOUT_DUE ||
    journey.currentState === GuestJourneyState.JOURNEY_COMPLETED ||
    journey.currentState === GuestJourneyState.JOURNEY_CANCELLED
  ) {
    return {
      journeyId: journey.id,
      currentState: journey.currentState,
      transitioned: false,
    };
  }

  if (
    journey.currentState !==
    GuestJourneyState.READY_FOR_ARRIVAL
  ) {
    throw new Error(
      `Invalid Guest Journey transition from ${journey.currentState} to ${GuestJourneyState.STAY_ACTIVE}.`
    );
  }

  const transitionStartedAt = now;

  const transitionResult =
    await tx.guestJourney.updateMany({
      where: {
        id: journey.id,
        currentState:
          GuestJourneyState.READY_FOR_ARRIVAL,
      },
      data: {
        currentState:
          GuestJourneyState.STAY_ACTIVE,
        stateChangedAt: transitionStartedAt,
        stayActiveAt: transitionStartedAt,
      },
    });

  if (transitionResult.count === 0) {
    const currentJourney =
      await tx.guestJourney.findUniqueOrThrow({
        where: {
          id: journey.id,
        },
        select: {
          id: true,
          currentState: true,
        },
      });

    return {
      journeyId: currentJourney.id,
      currentState: currentJourney.currentState,
      transitioned: false,
    };
  }

  const transitionCompletedAt = new Date();

  const auditEntry: AuditEntry = {
    engine: "Guest Journey",
    decisionId:
      `guest-journey:${journey.id}:` +
      "ready-for-arrival-to-stay-active",
    entityType: "RESERVATION",
    entityId: reservation.id,
    eventType: "DECISION_APPLIED",
    status: "SUCCESS",
    severity: "INFO",
    summary:
      "Guest Journey advanced to stay active.",
    reason:
      "The scheduled stay window began while the reservation remained active and guest access remained released.",
    startedAt: transitionStartedAt,
    completedAt: transitionCompletedAt,
    durationMs: Math.max(
      0,
      transitionCompletedAt.getTime() -
        transitionStartedAt.getTime()
    ),
    decisions: [
      {
        engine: "Guest Journey",
        rule:
          "READY_FOR_ARRIVAL_TO_STAY_ACTIVE",
        label:
          "Begin Scheduled Guest Stay Window",
        previousValue:
          GuestJourneyState.READY_FOR_ARRIVAL,
        newValue:
          GuestJourneyState.STAY_ACTIVE,
        applied: true,
        metadata: {
          journeyId: journey.id,
          reservationId: reservation.id,
          checkIn: reservation.checkIn,
          checkOut: reservation.checkOut,
        },
      },
    ],
    metadata: {
      journeyId: journey.id,
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      organizationId:
        reservation.property.organizationId,
      fromState:
        GuestJourneyState.READY_FOR_ARRIVAL,
      toState:
        GuestJourneyState.STAY_ACTIVE,
      stayActiveAt: transitionStartedAt,
      checkIn: reservation.checkIn,
      checkOut: reservation.checkOut,
      guestAccessReleasedAt:
        reservation.guestAccessReleasedAt,
      physicalArrivalConfirmed: false,
    },
  };

  await persistAuditEntry(tx, auditEntry);

  return {
    journeyId: journey.id,
    currentState:
      GuestJourneyState.STAY_ACTIVE,
    transitioned: true,
  };
}

export type MarkGuestJourneyCheckoutDueResult = {
  journeyId: string;
  currentState: GuestJourneyState;
  transitioned: boolean;
};

export async function markGuestJourneyCheckoutDue(
  tx: GuestJourneyTransactionClient,
  reservationId: string,
  now: Date = new Date()
): Promise<MarkGuestJourneyCheckoutDueResult> {
  const cleanReservationId = reservationId.trim();

  if (!cleanReservationId) {
    throw new Error("reservationId is required");
  }

  const reservation = await tx.reservation.findUnique({
    where: {
      id: cleanReservationId,
    },
    select: {
      id: true,
      status: true,
      propertyId: true,
      checkIn: true,
      checkOut: true,
      property: {
        select: {
          organizationId: true,
        },
      },
    },
  });

  if (!reservation) {
    throw new Error(
      `Cannot mark Guest Journey checkout due. Reservation ${cleanReservationId} was not found.`
    );
  }

  if (reservation.status !== ReservationStatus.ACTIVE) {
    throw new Error(
      `Cannot mark Guest Journey checkout due for reservation ${cleanReservationId} with status ${reservation.status}.`
    );
  }

  if (now.getTime() < reservation.checkOut.getTime()) {
    throw new Error(
      `Cannot mark Guest Journey checkout due before ${reservation.checkOut.toISOString()}.`
    );
  }

  const journey = await tx.guestJourney.findUnique({
    where: {
      reservationId: reservation.id,
    },
    select: {
      id: true,
      currentState: true,
    },
  });

  if (!journey) {
    throw new Error(
      `Cannot mark Guest Journey checkout due. Journey for reservation ${cleanReservationId} was not found.`
    );
  }

  if (
    journey.currentState ===
      GuestJourneyState.CHECKOUT_DUE ||
    journey.currentState ===
      GuestJourneyState.JOURNEY_COMPLETED ||
    journey.currentState ===
      GuestJourneyState.JOURNEY_CANCELLED
  ) {
    return {
      journeyId: journey.id,
      currentState: journey.currentState,
      transitioned: false,
    };
  }

  if (
    journey.currentState !==
    GuestJourneyState.STAY_ACTIVE
  ) {
    throw new Error(
      `Invalid Guest Journey transition from ${journey.currentState} to ${GuestJourneyState.CHECKOUT_DUE}.`
    );
  }

  const transitionStartedAt = now;

  const transitionResult =
    await tx.guestJourney.updateMany({
      where: {
        id: journey.id,
        currentState:
          GuestJourneyState.STAY_ACTIVE,
      },
      data: {
        currentState:
          GuestJourneyState.CHECKOUT_DUE,
        stateChangedAt: transitionStartedAt,
        checkoutDueAt: transitionStartedAt,
      },
    });

  if (transitionResult.count === 0) {
    const currentJourney =
      await tx.guestJourney.findUniqueOrThrow({
        where: {
          id: journey.id,
        },
        select: {
          id: true,
          currentState: true,
        },
      });

    return {
      journeyId: currentJourney.id,
      currentState: currentJourney.currentState,
      transitioned: false,
    };
  }

  const transitionCompletedAt = new Date();

  const auditEntry: AuditEntry = {
    engine: "Guest Journey",
    decisionId:
      `guest-journey:${journey.id}:` +
      "stay-active-to-checkout-due",
    entityType: "RESERVATION",
    entityId: reservation.id,
    eventType: "DECISION_APPLIED",
    status: "SUCCESS",
    severity: "INFO",
    summary:
      "Guest Journey advanced to checkout due.",
    reason:
      "The scheduled checkout time was reached while the reservation remained active.",
    startedAt: transitionStartedAt,
    completedAt: transitionCompletedAt,
    durationMs: Math.max(
      0,
      transitionCompletedAt.getTime() -
        transitionStartedAt.getTime()
    ),
    decisions: [
      {
        engine: "Guest Journey",
        rule:
          "STAY_ACTIVE_TO_CHECKOUT_DUE",
        label:
          "Begin Scheduled Guest Checkout",
        previousValue:
          GuestJourneyState.STAY_ACTIVE,
        newValue:
          GuestJourneyState.CHECKOUT_DUE,
        applied: true,
        metadata: {
          journeyId: journey.id,
          reservationId: reservation.id,
          checkIn: reservation.checkIn,
          checkOut: reservation.checkOut,
        },
      },
    ],
    metadata: {
      journeyId: journey.id,
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      organizationId:
        reservation.property.organizationId,
      fromState:
        GuestJourneyState.STAY_ACTIVE,
      toState:
        GuestJourneyState.CHECKOUT_DUE,
      checkoutDueAt: transitionStartedAt,
      checkIn: reservation.checkIn,
      checkOut: reservation.checkOut,
      accessRevocationCompleted: false,
    },
  };

  await persistAuditEntry(tx, auditEntry);

  return {
    journeyId: journey.id,
    currentState:
      GuestJourneyState.CHECKOUT_DUE,
    transitioned: true,
  };
}
export type CompleteGuestJourneyResult = {
  journeyId: string;
  currentState: GuestJourneyState;
  transitioned: boolean;
};

export async function completeGuestJourney(
  tx: GuestJourneyTransactionClient,
  reservationId: string,
  now: Date = new Date()
): Promise<CompleteGuestJourneyResult> {
  const cleanReservationId = reservationId.trim();

  if (!cleanReservationId) {
    throw new Error("reservationId is required");
  }

  const reservation = await tx.reservation.findUnique({
    where: {
      id: cleanReservationId,
    },
    select: {
      id: true,
      status: true,
      propertyId: true,
      checkIn: true,
      checkOut: true,
      property: {
        select: {
          organizationId: true,
        },
      },
    },
  });

  if (!reservation) {
    throw new Error(
      `Cannot complete Guest Journey. Reservation ${cleanReservationId} was not found.`
    );
  }

  if (now.getTime() < reservation.checkOut.getTime()) {
    throw new Error(
      `Cannot complete Guest Journey before ${reservation.checkOut.toISOString()}.`
    );
  }

  const journey = await tx.guestJourney.findUnique({
    where: {
      reservationId: reservation.id,
    },
    select: {
      id: true,
      currentState: true,
    },
  });

  if (!journey) {
    throw new Error(
      `Cannot complete Guest Journey. Journey for reservation ${cleanReservationId} was not found.`
    );
  }

  if (
    journey.currentState ===
      GuestJourneyState.JOURNEY_COMPLETED ||
    journey.currentState ===
      GuestJourneyState.JOURNEY_CANCELLED
  ) {
    return {
      journeyId: journey.id,
      currentState: journey.currentState,
      transitioned: false,
    };
  }

  if (
    journey.currentState !==
    GuestJourneyState.CHECKOUT_DUE
  ) {
    throw new Error(
      `Invalid Guest Journey transition from ${journey.currentState} to ${GuestJourneyState.JOURNEY_COMPLETED}.`
    );
  }

  const guestAccessGrants =
    await tx.accessGrant.findMany({
      where: {
        reservationId: reservation.id,
        type: "GUEST",
      },
      select: {
        id: true,
        status: true,
        method: true,
        ttlockKeyboardPwdId: true,
        revokedReason: true,
        lastError: true,
      },
    });

  if (guestAccessGrants.length === 0) {
    throw new Error(
      `Cannot complete Guest Journey for reservation ${cleanReservationId} without guest access history.`
    );
  }

  const unresolvedGuestAccess =
    guestAccessGrants.filter(
      (grant) => grant.status !== "REVOKED"
    );

  if (unresolvedGuestAccess.length > 0) {
    throw new Error(
      `Cannot complete Guest Journey for reservation ${cleanReservationId} while ${unresolvedGuestAccess.length} guest access grant(s) remain unresolved.`
    );
  }

  const unresolvedGuestNfc =
    await tx.nfcAssignment.findFirst({
      where: {
        reservationId: reservation.id,
        role: "GUEST",
        status: {
          in: [
            "SCHEDULED",
            "ACTIVE",
            "FAILED",
          ],
        },
      },
      select: {
        id: true,
        status: true,
        lastError: true,
      },
    });

  if (unresolvedGuestNfc) {
    throw new Error(
      `Cannot complete Guest Journey for reservation ${cleanReservationId} while guest NFC assignment ${unresolvedGuestNfc.id} remains ${unresolvedGuestNfc.status}.`
    );
  }

  const transitionStartedAt = now;

  const transitionResult =
    await tx.guestJourney.updateMany({
      where: {
        id: journey.id,
        currentState:
          GuestJourneyState.CHECKOUT_DUE,
      },
      data: {
        currentState:
          GuestJourneyState.JOURNEY_COMPLETED,
        stateChangedAt: transitionStartedAt,
        completedAt: transitionStartedAt,
      },
    });

  if (transitionResult.count === 0) {
    const currentJourney =
      await tx.guestJourney.findUniqueOrThrow({
        where: {
          id: journey.id,
        },
        select: {
          id: true,
          currentState: true,
        },
      });

    return {
      journeyId: currentJourney.id,
      currentState: currentJourney.currentState,
      transitioned: false,
    };
  }

  const transitionCompletedAt = new Date();

  const auditEntry: AuditEntry = {
    engine: "Guest Journey",
    decisionId:
      `guest-journey:${journey.id}:` +
      "checkout-due-to-journey-completed",
    entityType: "RESERVATION",
    entityId: reservation.id,
    eventType: "DECISION_APPLIED",
    status: "SUCCESS",
    severity: "INFO",
    summary:
      "Guest Journey completed.",
    reason:
      "The scheduled stay ended and all persisted guest access credentials were closed.",
    startedAt: transitionStartedAt,
    completedAt: transitionCompletedAt,
    durationMs: Math.max(
      0,
      transitionCompletedAt.getTime() -
        transitionStartedAt.getTime()
    ),
    decisions: [
      {
        engine: "Guest Journey",
        rule:
          "CHECKOUT_DUE_TO_JOURNEY_COMPLETED",
        label:
          "Complete Guest Journey",
        previousValue:
          GuestJourneyState.CHECKOUT_DUE,
        newValue:
          GuestJourneyState.JOURNEY_COMPLETED,
        applied: true,
        metadata: {
          journeyId: journey.id,
          reservationId: reservation.id,
          guestAccessGrantCount:
            guestAccessGrants.length,
        },
      },
    ],
    metadata: {
      journeyId: journey.id,
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      organizationId:
        reservation.property.organizationId,
      fromState:
        GuestJourneyState.CHECKOUT_DUE,
      toState:
        GuestJourneyState.JOURNEY_COMPLETED,
      completedAt: transitionStartedAt,
      checkIn: reservation.checkIn,
      checkOut: reservation.checkOut,
      reservationStatus: reservation.status,
      guestAccessGrantCount:
        guestAccessGrants.length,
      allGuestAccessGrantsRevoked: true,
      unresolvedGuestNfc: false,
    },
  };

  await persistAuditEntry(tx, auditEntry);

  return {
    journeyId: journey.id,
    currentState:
      GuestJourneyState.JOURNEY_COMPLETED,
    transitioned: true,
  };
}
export type CancelGuestJourneyResult = {
  journeyId: string;
  currentState: GuestJourneyState;
  transitioned: boolean;
};

export async function cancelGuestJourney(
  tx: GuestJourneyTransactionClient,
  reservationId: string,
  now: Date = new Date()
): Promise<CancelGuestJourneyResult> {
  const cleanReservationId = reservationId.trim();

  if (!cleanReservationId) {
    throw new Error("reservationId is required");
  }

  const reservation = await tx.reservation.findUnique({
    where: {
      id: cleanReservationId,
    },
    select: {
      id: true,
      status: true,
      propertyId: true,
      cancelledAt: true,
      cancelledBy: true,
      cancellationReason: true,
      externalProvider: true,
      externalUpdatedAt: true,
      updatedAt: true,
      property: {
        select: {
          organizationId: true,
        },
      },
    },
  });

  if (!reservation) {
    throw new Error(
      `Cannot cancel Guest Journey. Reservation ${cleanReservationId} was not found.`
    );
  }

  if (
    reservation.status !==
    ReservationStatus.CANCELLED
  ) {
    throw new Error(
      `Cannot cancel Guest Journey for reservation ${cleanReservationId} with status ${reservation.status}.`
    );
  }

  const journey = await tx.guestJourney.findUnique({
    where: {
      reservationId: reservation.id,
    },
    select: {
      id: true,
      currentState: true,
    },
  });

  if (!journey) {
    throw new Error(
      `Cannot cancel Guest Journey. Journey for reservation ${cleanReservationId} was not found.`
    );
  }

  if (
    journey.currentState ===
      GuestJourneyState.JOURNEY_CANCELLED ||
    journey.currentState ===
      GuestJourneyState.JOURNEY_COMPLETED
  ) {
    return {
      journeyId: journey.id,
      currentState: journey.currentState,
      transitioned: false,
    };
  }

  const previousState = journey.currentState;

  const cancellationEffectiveAt =
    reservation.cancelledAt ??
    reservation.externalUpdatedAt ??
    reservation.updatedAt ??
    now;

  const operationStartedAt = new Date();

  const transitionResult =
    await tx.guestJourney.updateMany({
      where: {
        id: journey.id,
        currentState: previousState,
      },
      data: {
        currentState:
          GuestJourneyState.JOURNEY_CANCELLED,
        stateChangedAt:
          cancellationEffectiveAt,
        cancelledAt:
          cancellationEffectiveAt,
      },
    });

  if (transitionResult.count === 0) {
    const currentJourney =
      await tx.guestJourney.findUniqueOrThrow({
        where: {
          id: journey.id,
        },
        select: {
          id: true,
          currentState: true,
        },
      });

    return {
      journeyId: currentJourney.id,
      currentState:
        currentJourney.currentState,
      transitioned: false,
    };
  }

  const operationCompletedAt = new Date();

  const auditEntry: AuditEntry = {
    engine: "Guest Journey",
    decisionId:
      `guest-journey:${journey.id}:` +
      "journey-cancelled",
    entityType: "RESERVATION",
    entityId: reservation.id,
    eventType: "DECISION_APPLIED",
    status: "SUCCESS",
    severity: "INFO",
    summary:
      "Guest Journey cancelled.",
    reason:
      "The reservation entered its canonical cancelled state, so the guest lifecycle was terminated.",
    startedAt: operationStartedAt,
    completedAt: operationCompletedAt,
    durationMs: Math.max(
      0,
      operationCompletedAt.getTime() -
        operationStartedAt.getTime()
    ),
    decisions: [
      {
        engine: "Guest Journey",
        rule:
          "RESERVATION_CANCELLED_TO_JOURNEY_CANCELLED",
        label:
          "Terminate Cancelled Guest Journey",
        previousValue: previousState,
        newValue:
          GuestJourneyState.JOURNEY_CANCELLED,
        applied: true,
        metadata: {
          journeyId: journey.id,
          reservationId: reservation.id,
          reservationStatus:
            reservation.status,
          cancelledBy:
            reservation.cancelledBy,
        },
      },
    ],
    metadata: {
      journeyId: journey.id,
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      organizationId:
        reservation.property.organizationId,
      fromState: previousState,
      toState:
        GuestJourneyState.JOURNEY_CANCELLED,
      cancellationEffectiveAt,
      reservationCancelledAt:
        reservation.cancelledAt,
      reservationCancelledBy:
        reservation.cancelledBy,
      cancellationReason:
        reservation.cancellationReason,
      externalProvider:
        reservation.externalProvider,
      externalUpdatedAt:
        reservation.externalUpdatedAt,
      accessClosureOwnedBy:
        "Access Engine",
    },
  };

  await persistAuditEntry(tx, auditEntry);

  return {
    journeyId: journey.id,
    currentState:
      GuestJourneyState.JOURNEY_CANCELLED,
    transitioned: true,
  };
}
export type EnsureCancelledGuestJourneyResult = {
  journeyId: string;
  currentState: GuestJourneyState;
  created: boolean;
  transitioned: boolean;
};

export async function ensureGuestJourneyForCancelledReservation(
  tx: GuestJourneyTransactionClient,
  reservationId: string,
  now: Date = new Date()
): Promise<EnsureCancelledGuestJourneyResult> {
  const cleanReservationId = reservationId.trim();

  if (!cleanReservationId) {
    throw new Error("reservationId is required");
  }

  const reservation = await tx.reservation.findUnique({
    where: {
      id: cleanReservationId,
    },
    select: {
      id: true,
      status: true,
      propertyId: true,
      cancelledAt: true,
      cancelledBy: true,
      cancellationReason: true,
      externalProvider: true,
      externalUpdatedAt: true,
      updatedAt: true,
      property: {
        select: {
          organizationId: true,
        },
      },
    },
  });

  if (!reservation) {
    throw new Error(
      `Cannot initialize cancelled Guest Journey. Reservation ${cleanReservationId} was not found.`
    );
  }

  if (
    reservation.status !==
    ReservationStatus.CANCELLED
  ) {
    throw new Error(
      `Cannot initialize cancelled Guest Journey for reservation ${cleanReservationId} with status ${reservation.status}.`
    );
  }

  const cancellationEffectiveAt =
    reservation.cancelledAt ??
    reservation.externalUpdatedAt ??
    reservation.updatedAt ??
    now;

  const creationResult =
    await tx.guestJourney.createMany({
      data: {
        reservationId: reservation.id,
        currentState:
          GuestJourneyState.JOURNEY_CANCELLED,
        stateChangedAt:
          cancellationEffectiveAt,
        cancelledAt:
          cancellationEffectiveAt,
      },
      skipDuplicates: true,
    });

  const journey =
    await tx.guestJourney.findUniqueOrThrow({
      where: {
        reservationId: reservation.id,
      },
      select: {
        id: true,
        currentState: true,
      },
    });

  if (creationResult.count === 0) {
    const cancellationResult =
      await cancelGuestJourney(
        tx,
        reservation.id,
        now
      );

    return {
      ...cancellationResult,
      created: false,
    };
  }

  const auditEntry: AuditEntry = {
    engine: "Guest Journey",
    decisionId:
      `guest-journey:${journey.id}:` +
      "cancelled-reservation-initialization",
    entityType: "RESERVATION",
    entityId: reservation.id,
    eventType: "DECISION_APPLIED",
    status: "SUCCESS",
    severity: "INFO",
    summary:
      "Cancelled Guest Journey initialized.",
    reason:
      "The reservation was first observed in its canonical cancelled state, so no non-terminal guest lifecycle stages were synthesized.",
    startedAt: cancellationEffectiveAt,
    completedAt: cancellationEffectiveAt,
    durationMs: 0,
    decisions: [
      {
        engine: "Guest Journey",
        rule:
          "CANCELLED_RESERVATION_INITIALIZED_AS_JOURNEY_CANCELLED",
        label:
          "Initialize Cancelled Guest Journey",
        previousValue: null,
        newValue:
          GuestJourneyState.JOURNEY_CANCELLED,
        applied: true,
        metadata: {
          journeyId: journey.id,
          reservationId: reservation.id,
          reservationStatus:
            reservation.status,
          cancelledBy:
            reservation.cancelledBy,
        },
      },
    ],
    metadata: {
      journeyId: journey.id,
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      organizationId:
        reservation.property.organizationId,
      fromState: null,
      toState:
        GuestJourneyState.JOURNEY_CANCELLED,
      initializationMode:
        "DIRECT_TERMINAL_INITIALIZATION",
      cancellationEffectiveAt,
      reservationCancelledAt:
        reservation.cancelledAt,
      reservationCancelledBy:
        reservation.cancelledBy,
      cancellationReason:
        reservation.cancellationReason,
      externalProvider:
        reservation.externalProvider,
      externalUpdatedAt:
        reservation.externalUpdatedAt,
      accessClosureOwnedBy:
        "Access Engine",
    },
  };

  await persistAuditEntry(tx, auditEntry);

  return {
    journeyId: journey.id,
    currentState:
      GuestJourneyState.JOURNEY_CANCELLED,
    created: true,
    transitioned: true,
  };
}
