import {
  PaymentState,
  Prisma,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";
import stripe from "../billing/stripe";

const MAX_IDENTITY_VERIFICATION_ATTEMPTS = 3;

function readMoneyEnv(name: string, fallback: string) {
  const raw = String(process.env[name] ?? fallback).trim();
  const value = Number(raw);

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name}_INVALID`);
  }

  return new Prisma.Decimal(value.toFixed(2));
}

function validateReturnUrl(value: string) {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("GUEST_IDENTITY_RETURN_URL_INVALID");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("GUEST_IDENTITY_RETURN_URL_INVALID");
  }

  return url.toString();
}

export async function createGuestIdentityVerificationSession(
  prisma: PrismaClient,
  input: {
    reservationId: string;
    returnUrl: string;
  }
) {
  const reservation = await prisma.reservation.findUnique({
    where: {
      id: input.reservationId,
    },
    select: {
      id: true,
      reservationNumber: true,
      guestEmail: true,
      guestPhone: true,
      checkOut: true,
      paymentState: true,
      status: true,

      verificationStatus: true,
      verifiedAt: true,

      identityVerificationConsentAt: true,
      identityDeclaredLegalName: true,
      identityVerificationAttempts: true,
      identityVerificationProvider: true,

      stripeIdentityVerificationSessionId: true,
      stripeIdentityVerificationStatus: true,

      directBookingProtectionFeeAmount: true,
      identityVerificationProviderCostAmount: true,
    },
  });

  if (!reservation) {
    throw new Error("GUEST_IDENTITY_RESERVATION_NOT_FOUND");
  }

  if (!reservation.reservationNumber) {
    throw new Error("GUEST_IDENTITY_RESERVATION_NUMBER_MISSING");
  }

  if (reservation.status !== ReservationStatus.ACTIVE) {
    throw new Error("GUEST_IDENTITY_RESERVATION_NOT_ACTIVE");
  }

  if (reservation.paymentState !== PaymentState.PAID) {
    throw new Error("GUEST_IDENTITY_PAYMENT_NOT_PAID");
  }

  if (reservation.checkOut.getTime() <= Date.now()) {
    throw new Error("GUEST_IDENTITY_STAY_ALREADY_ENDED");
  }

  if (!reservation.identityVerificationConsentAt) {
    throw new Error("GUEST_IDENTITY_CONSENT_REQUIRED");
  }

    if (
    !String(
      reservation.identityDeclaredLegalName ?? ""
    ).trim()
  ) {
    throw new Error(
      "GUEST_IDENTITY_LEGAL_NAME_REQUIRED"
    );
  }

  if (
    reservation.verificationStatus === "COMPLETED" &&
    reservation.verifiedAt
  ) {
    return {
      ok: true,
      alreadyVerified: true,
      reused: false,
      reservationNumber: reservation.reservationNumber,
      verificationSessionId:
        reservation.stripeIdentityVerificationSessionId,
      status:
        reservation.stripeIdentityVerificationStatus ?? "verified",
      url: null,
    };
  }

  if (reservation.stripeIdentityVerificationSessionId) {
    let existingSession;

    try {
      existingSession =
        await stripe.identity.verificationSessions.retrieve(
          reservation.stripeIdentityVerificationSessionId
        );
    } catch (error: any) {
      console.error("[GUEST_IDENTITY] session retrieve failed", {
        reservationNumber: reservation.reservationNumber,
        verificationSessionId:
          reservation.stripeIdentityVerificationSessionId,
        error: error?.code ?? error?.type ?? "STRIPE_RETRIEVE_FAILED",
      });

      throw new Error("GUEST_IDENTITY_SESSION_RETRIEVE_FAILED");
    }

    await prisma.reservation.update({
      where: {
        id: reservation.id,
      },
      data: {
        identityVerificationProvider: "STRIPE_IDENTITY",
        stripeIdentityVerificationStatus: existingSession.status,
        stripeIdentityVerificationLastError:
          existingSession.last_error?.code ?? null,
        stripeIdentityVerificationLastEventAt: new Date(),
      },
    });

    if (existingSession.status === "verified") {
      return {
        ok: true,
        alreadyVerified: true,
        reused: true,
        reservationNumber: reservation.reservationNumber,
        verificationSessionId: existingSession.id,
        status: existingSession.status,
        url: null,
      };
    }

    if (
      reservation.identityVerificationAttempts >=
      MAX_IDENTITY_VERIFICATION_ATTEMPTS
    ) {
      throw new Error(
        "GUEST_IDENTITY_MAX_VERIFICATION_ATTEMPTS_REACHED"
      );
    }

    if (existingSession.status !== "canceled") {
      return {
        ok: true,
        alreadyVerified: false,
        reused: true,
        reservationNumber: reservation.reservationNumber,
        verificationSessionId: existingSession.id,
        status: existingSession.status,
        url: existingSession.url ?? null,
      };
    }
  }

  if (
    reservation.identityVerificationAttempts >=
    MAX_IDENTITY_VERIFICATION_ATTEMPTS
  ) {
    throw new Error(
      "GUEST_IDENTITY_MAX_VERIFICATION_ATTEMPTS_REACHED"
    );
  }

  const returnUrl = validateReturnUrl(input.returnUrl);

  const directBookingProtectionFeeAmount = readMoneyEnv(
    "DIRECT_BOOKING_PROTECTION_FEE_AMOUNT",
    "2.50"
  );

  const identityVerificationProviderCostAmount = readMoneyEnv(
    "STRIPE_IDENTITY_PROVIDER_COST_AMOUNT",
    "1.50"
  );

  const providedDetails = {
    ...(reservation.guestEmail
      ? { email: reservation.guestEmail }
      : {}),
    ...(reservation.guestPhone
      ? { phone: reservation.guestPhone }
      : {}),
  };

  const attemptNumber =
    reservation.identityVerificationAttempts + 1;

  const session =
    await stripe.identity.verificationSessions.create(
      {
        type: "document",
        client_reference_id: reservation.reservationNumber,
        return_url: returnUrl,
        metadata: {
          reservationId: reservation.id,
          reservationNumber: reservation.reservationNumber,
          flow: "pin_go_direct_booking_guest_identity",
        },
        options: {
          document: {
            require_live_capture: true,
            require_matching_selfie: true,
          },
        },
        ...(Object.keys(providedDetails).length > 0
          ? { provided_details: providedDetails }
          : {}),
      },
      {
        idempotencyKey:
          `guest-identity-${reservation.id}-${attemptNumber}`,
      }
    );

  await prisma.reservation.update({
    where: {
      id: reservation.id,
    },
    data: {
      verificationStatus: "IN_PROGRESS",
      identityVerificationProvider: "STRIPE_IDENTITY",
      stripeIdentityVerificationSessionId: session.id,
      stripeIdentityVerificationStatus: session.status,
      stripeIdentityVerificationLastError: null,
      stripeIdentityVerificationLastEventAt: new Date(),

      directBookingProtectionFeeAmount:
        reservation.directBookingProtectionFeeAmount ??
        directBookingProtectionFeeAmount,

      identityVerificationProviderCostAmount:
        reservation.identityVerificationProviderCostAmount ??
        identityVerificationProviderCostAmount,
    },
  });

  console.log("[GUEST_IDENTITY] verification session ready", {
    reservationNumber: reservation.reservationNumber,
    verificationSessionId: session.id,
    status: session.status,
    reused: false,
  });

  return {
    ok: true,
    alreadyVerified: false,
    reused: false,
    reservationNumber: reservation.reservationNumber,
    verificationSessionId: session.id,
    status: session.status,
    url: session.url ?? null,
  };
}