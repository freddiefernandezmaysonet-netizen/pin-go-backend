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
  "reservation" | "guestJourney" | "apmsAuditEntry"
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