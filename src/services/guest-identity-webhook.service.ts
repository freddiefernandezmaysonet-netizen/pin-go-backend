import {
  PrismaClient,
} from "@prisma/client";
import Stripe from "stripe";
import stripe from "../billing/stripe";
import {
  evaluateGuestAccessReadiness,
} from "./guest-access-readiness.service";
import { completeGuestJourneyVerification } from "./guest-journey.service";

const MAX_IDENTITY_VERIFICATION_ATTEMPTS = 3;

const reservationSelect = {
  id: true,
  reservationNumber: true,
  guestName: true,
  verificationStatus: true,
  verifiedAt: true,
  identityDeclaredLegalName: true,
  identityVerificationAttempts: true,
  stripeIdentityVerificationSessionId: true,
  stripeIdentityVerificationLastEventId: true,
} as const;

function normalizeNameTokens(value: string) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort();
}

function namesHaveSameTokens(
  first: string,
  second: string
) {
  const firstTokens = normalizeNameTokens(first);
  const secondTokens = normalizeNameTokens(second);

  if (
    firstTokens.length === 0 ||
    secondTokens.length === 0 ||
    firstTokens.length !== secondTokens.length
  ) {
    return false;
  }

  return firstTokens.every(
    (token, index) =>
      token === secondTokens[index]
  );
}

function reservationNameMatchesVerifiedName(
  reservationName: string,
  verifiedName: string
) {
  const reservationTokens =
    normalizeNameTokens(reservationName);

  const verifiedTokens =
    normalizeNameTokens(verifiedName);

  if (
    reservationTokens.length === 0 ||
    verifiedTokens.length === 0
  ) {
    return false;
  }

  return reservationTokens.every((token) =>
    verifiedTokens.includes(token)
  );
}

export async function handleGuestIdentityStripeEvent(
  prisma: PrismaClient,
  event: Stripe.Event
) {
  if (
    event.type !== "identity.verification_session.verified" &&
    event.type !== "identity.verification_session.requires_input"
  ) {
    return {
      handled: false,
    };
  }

  const session =
    event.data.object as Stripe.Identity.VerificationSession;

  const flow = String(
    session.metadata?.flow ?? ""
  ).trim();

  if (flow !== "pin_go_direct_booking_guest_identity") {
    return {
      handled: false,
      skipped: true,
      reason: "IDENTITY_FLOW_NOT_MANAGED_BY_PIN_GO",
    };
  }

  let reservation = await prisma.reservation.findUnique({
    where: {
      stripeIdentityVerificationSessionId: session.id,
    },
    select: reservationSelect,
  });

  if (!reservation) {
    const metadataReservationId = String(
      session.metadata?.reservationId ?? ""
    ).trim();

    const metadataReservationNumber = String(
      session.metadata?.reservationNumber ?? ""
    ).trim();

    if (metadataReservationId && metadataReservationNumber) {
      const metadataReservation =
        await prisma.reservation.findFirst({
          where: {
            id: metadataReservationId,
            reservationNumber: metadataReservationNumber,
          },
          select: reservationSelect,
        });

      if (metadataReservation) {
        await prisma.reservation.update({
          where: {
            id: metadataReservation.id,
          },
          data: {
            identityVerificationProvider: "STRIPE_IDENTITY",
            stripeIdentityVerificationSessionId: session.id,
          },
        });

        reservation = metadataReservation;
      }
    }
  }

  if (!reservation) {
    console.error(
      "[GUEST_IDENTITY] reservation not resolved for Stripe event",
      {
        eventId: event.id,
        eventType: event.type,
        verificationSessionId: session.id,
      }
    );

    throw new Error(
      "GUEST_IDENTITY_WEBHOOK_RESERVATION_NOT_RESOLVED"
    );
  }

  if (
    reservation.stripeIdentityVerificationLastEventId ===
    event.id
  ) {
    return {
      handled: true,
      skipped: true,
      reason: "STRIPE_EVENT_ALREADY_PROCESSED",
      reservationNumber: reservation.reservationNumber,
    };
  }

  const eventAt = new Date(event.created * 1000);

  if (
    event.type ===
    "identity.verification_session.verified"
  ) {
    const verifiedSession =
      await stripe.identity.verificationSessions.retrieve(
        session.id,
        {
          expand: ["verified_outputs"],
        }
      );

    const verifiedFirstName = String(
      verifiedSession.verified_outputs
        ?.first_name ?? ""
    ).trim();

    const verifiedLastName = String(
      verifiedSession.verified_outputs
        ?.last_name ?? ""
    ).trim();

    const verifiedLegalName = [
      verifiedFirstName,
      verifiedLastName,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();

    const declaredLegalName = String(
      reservation.identityDeclaredLegalName ?? ""
    ).trim();

    const declaredNameMatches =
      namesHaveSameTokens(
        declaredLegalName,
        verifiedLegalName
      );

    const bookingNameMatches =
      reservationNameMatchesVerifiedName(
        reservation.guestName,
        verifiedLegalName
      );

    const identityNameMatches =
      declaredNameMatches &&
      bookingNameMatches;

    if (!identityNameMatches) {
      const updated =
        await prisma.reservation.updateMany({
          where: {
            id: reservation.id,
            OR: [
              {
                stripeIdentityVerificationLastEventId:
                  null,
              },
              {
                stripeIdentityVerificationLastEventId:
                  {
                    not: event.id,
                  },
              },
            ],
          },
          data: {
            verificationStatus:
              "REVIEW_REQUIRED",
            identityVerificationProvider:
              "STRIPE_IDENTITY",
            stripeIdentityVerificationStatus:
              session.status,
            stripeIdentityVerificationLastError:
              "IDENTITY_NAME_MISMATCH",
            stripeIdentityVerificationLastEventAt:
              eventAt,
            stripeIdentityVerificationLastEventId:
              event.id,
            identityVerifiedLegalName:
              verifiedLegalName || null,
            identityNameMatchStatus:
              "REVIEW_REQUIRED",
          },
        });

      if (updated.count === 0) {
        return {
          handled: true,
          skipped: true,
          reason:
            "STRIPE_EVENT_ALREADY_PROCESSED",
          reservationNumber:
            reservation.reservationNumber,
        };
      }

      const readiness =
        await evaluateGuestAccessReadiness(
          prisma,
          reservation.id,
          {
            persist: true,
            now: eventAt,
          }
        );

      console.warn(
        "[GUEST_IDENTITY] verified identity name mismatch",
        {
          reservationNumber:
            reservation.reservationNumber,
          verificationSessionId:
            session.id,
          eventId: event.id,
          declaredNameMatches,
          bookingNameMatches,
        }
      );

      return {
        handled: true,
        verified: false,
        reviewRequired: true,
        reason: "IDENTITY_NAME_MISMATCH",
        reservationNumber:
          reservation.reservationNumber,
        readiness,
      };
    }

      const verificationCompletion =
        await prisma.$transaction(async (tx) => {
        const updated =
          await tx.reservation.updateMany({
            where: {
              id: reservation.id,
              OR: [
                {
                  stripeIdentityVerificationLastEventId:
                    null,
                },
                {
                  stripeIdentityVerificationLastEventId:
                    {
                      not: event.id,
                    },
                },
              ],
            },
            data: {
              verificationStatus: "COMPLETED",
              verifiedAt:
                reservation.verifiedAt ?? eventAt,
              identityVerificationProvider:
                "STRIPE_IDENTITY",
              stripeIdentityVerificationStatus:
                session.status,
              stripeIdentityVerificationLastError:
                null,
              stripeIdentityVerificationLastEventAt:
                eventAt,
              stripeIdentityVerificationLastEventId:
                event.id,
              identityVerifiedLegalName:
                verifiedLegalName,
              identityNameMatchStatus: "MATCHED",
            },
          });

        if (updated.count === 0) {
          return {
            skipped: true as const,
          };
        }

        const guestJourneyResult =
          await completeGuestJourneyVerification(
            tx,
            reservation.id
          );

        return {
          skipped: false as const,
          guestJourneyResult,
        };
      });

    if (verificationCompletion.skipped) {
      return {
        handled: true,
        skipped: true,
        reason:
          "STRIPE_EVENT_ALREADY_PROCESSED",
        reservationNumber:
          reservation.reservationNumber,
      };
    }

    const guestJourneyResult =
      verificationCompletion.guestJourneyResult;

    const readiness =
      await evaluateGuestAccessReadiness(
        prisma,
        reservation.id,
        {
          persist: true,
          now: eventAt,
        }
      );

    console.log(
      "[GUEST_IDENTITY] identity verified and matched",
      {
        reservationNumber:
          reservation.reservationNumber,
        verificationSessionId:
          session.id,
        eventId: event.id,
        guestJourneyState:
          guestJourneyResult.currentState,
        guestJourneyTransitioned:
          guestJourneyResult.transitioned,
        guestAccessReady:
          readiness.ready,
        blockers:
          readiness.blockers,
      }
    );

    return {
      handled: true,
      verified: true,
      reservationNumber:
        reservation.reservationNumber,
      readiness,
    }; 
  }

  if (
    reservation.verificationStatus === "COMPLETED" &&
    reservation.verifiedAt
  ) {
    console.warn(
      "[GUEST_IDENTITY] stale requires_input ignored",
      {
        reservationNumber:
          reservation.reservationNumber,
        verificationSessionId: session.id,
        eventId: event.id,
      }
    );

    return {
      handled: true,
      skipped: true,
      reason:
        "VERIFICATION_ALREADY_COMPLETED",
      reservationNumber:
        reservation.reservationNumber,
    };
  }

  const nextAttempts =
    reservation.identityVerificationAttempts + 1;

  const nextVerificationStatus =
    nextAttempts >=
    MAX_IDENTITY_VERIFICATION_ATTEMPTS
      ? "FAILED"
      : "REQUIRES_INPUT";

  const updated = await prisma.reservation.updateMany({
    where: {
      id: reservation.id,
      verificationStatus: {
        not: "COMPLETED",
      },
      OR: [
        {
          stripeIdentityVerificationLastEventId: null,
        },
        {
          stripeIdentityVerificationLastEventId: {
            not: event.id,
          },
        },
      ],
    },
    data: {
      verificationStatus: nextVerificationStatus,
      identityVerificationProvider: "STRIPE_IDENTITY",
      stripeIdentityVerificationStatus: session.status,
      stripeIdentityVerificationLastError:
        session.last_error?.code ??
        "IDENTITY_VERIFICATION_REQUIRES_INPUT",
      stripeIdentityVerificationLastEventAt: eventAt,
      stripeIdentityVerificationLastEventId: event.id,
      identityVerificationAttempts: {
        increment: 1,
      },
    },
  });

  if (updated.count === 0) {
    return {
      handled: true,
      skipped: true,
      reason:
        "STRIPE_EVENT_ALREADY_PROCESSED_OR_COMPLETED",
      reservationNumber:
        reservation.reservationNumber,
    };
  }

  const readiness =
    await evaluateGuestAccessReadiness(
      prisma,
      reservation.id,
      {
        persist: true,
        now: eventAt,
      }
    );
  
  console.warn(
    "[GUEST_IDENTITY] verification requires input",
    {
      reservationNumber:
        reservation.reservationNumber,
      verificationSessionId: session.id,
      eventId: event.id,
      errorCode:
        session.last_error?.code ?? null,
      attempts: nextAttempts,
      maxAttempts:
        MAX_IDENTITY_VERIFICATION_ATTEMPTS,
    }
  );

  return {
    handled: true,
    verified: false,
    requiresInput: true,
    maxAttemptsReached:
      nextAttempts >=
      MAX_IDENTITY_VERIFICATION_ATTEMPTS,
    reservationNumber:
      reservation.reservationNumber,
    readiness,
  };
}

export async function reconcileGuestIdentityVerificationSession(
  prisma: PrismaClient,
  reservationId: string
) {
  const reservation =
    await prisma.reservation.findUnique({
      where: {
        id: reservationId,
      },
      select: {
        id: true,
        reservationNumber: true,
        verificationStatus: true,
        verifiedAt: true,
        stripeIdentityVerificationSessionId:
          true,
      },
    });
  
  if (!reservation) {
    throw new Error(
      "GUEST_IDENTITY_RECONCILIATION_RESERVATION_NOT_FOUND"
    );
  }

  if (
    reservation.verificationStatus ===
      "COMPLETED" &&
    reservation.verifiedAt
  ) {
    return {
      handled: true,
      alreadyCompleted: true,
      status: "verified",
      reservationNumber:
        reservation.reservationNumber,
    };
  }

  const verificationSessionId =
    reservation.stripeIdentityVerificationSessionId;

  if (!verificationSessionId) {
    return {
      handled: false,
      skipped: true,
      reason:
        "GUEST_IDENTITY_VERIFICATION_SESSION_MISSING",
      reservationNumber:
        reservation.reservationNumber,
    };
  }

  const session =
    await stripe.identity.verificationSessions.retrieve(
      verificationSessionId
    );

  if (
    session.status === "verified" ||
    session.status === "requires_input"
  ) {
    const eventType =
      session.status === "verified"
        ? "identity.verification_session.verified"
        : "identity.verification_session.requires_input";

    const reconciliationEvent = {
      id:
        `identity-reconciliation:${session.id}:${session.status}`,
      object: "event",
      api_version: "2023-10-16",
      created: Math.floor(
        Date.now() / 1000
      ),
      data: {
        object: session,
      },
      livemode: true,
      pending_webhooks: 0,
      request: {
        id: null,
        idempotency_key: null,
      },
      type: eventType,
    } as unknown as Stripe.Event;

    return handleGuestIdentityStripeEvent(
      prisma,
      reconciliationEvent
    );
  }

  if (session.status === "canceled") {
    const reconciliationEvent = {
      id:
        `identity-reconciliation:${session.id}:canceled`,
      object: "event",
      api_version: "2023-10-16",
      created: Math.floor(
        Date.now() / 1000
      ),
      data: {
        object: session,
      },
      livemode: true,
      pending_webhooks: 0,
      request: {
        id: null,
        idempotency_key: null,
      },

      // El procesador existente convierte
      // requires_input en una acción recuperable.
      type:
        "identity.verification_session.requires_input",
    } as unknown as Stripe.Event;

    return handleGuestIdentityStripeEvent(
      prisma,
      reconciliationEvent
    );
  }

  await prisma.reservation.updateMany({
    where: {
      id: reservation.id,
      verificationStatus: {
        not: "COMPLETED",
      },
    },
    data: {
      verificationStatus: "IN_PROGRESS",
      identityVerificationProvider:
        "STRIPE_IDENTITY",
      stripeIdentityVerificationStatus:
        session.status,
      stripeIdentityVerificationLastError:
        session.last_error?.code ?? null,
      stripeIdentityVerificationLastEventAt:
        new Date(),
    },
  });

  return {
    handled: true,
    processing: true,
    status: session.status,
    reservationNumber:
      reservation.reservationNumber,
  };
}