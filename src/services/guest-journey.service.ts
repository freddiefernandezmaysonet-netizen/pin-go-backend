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

  if (
    reservation.verificationStatus !== "COMPLETED" ||
    !reservation.verifiedAt
  ) {
    throw new Error(
      `Cannot complete Guest Journey verification for reservation ${cleanReservationId} without completed verification evidence.`
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
      verificationCompletedAt: reservation.verifiedAt,
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
      "The guest successfully completed the required identity verification.",
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