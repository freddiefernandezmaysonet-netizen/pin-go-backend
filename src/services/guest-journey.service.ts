import {
  GuestJourneyState,
  Prisma,
  ReservationStatus,
} from "@prisma/client";

export type EnsureGuestJourneyResult = {
  journeyId: string;
  currentState: GuestJourneyState;
  created: boolean;
};

type GuestJourneyTransactionClient = Pick<
  Prisma.TransactionClient,
  "reservation" | "guestJourney"
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

  const existingJourney = await tx.guestJourney.findUnique({
    where: {
      reservationId: reservation.id,
    },
    select: {
      id: true,
      currentState: true,
    },
  });

  if (existingJourney) {
    return {
      journeyId: existingJourney.id,
      currentState: existingJourney.currentState,
      created: false,
    };
  }

  const createdJourney = await tx.guestJourney.create({
    data: {
      reservationId: reservation.id,
      currentState: GuestJourneyState.RESERVATION_CONFIRMED,
    },
    select: {
      id: true,
      currentState: true,
    },
  });

  return {
    journeyId: createdJourney.id,
    currentState: createdJourney.currentState,
    created: true,
  };
}