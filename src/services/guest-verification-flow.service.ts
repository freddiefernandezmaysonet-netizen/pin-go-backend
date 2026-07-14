import {
  PaymentState,
  Prisma,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";
import {
  createGuestIdentityVerificationSession,
} from "./guest-identity-verification.service";

type AgreementSnapshot = {
  agreementId: string;
  propertyId: string;
  version: string;
  title: string;
  agreementText: string;
  rules: unknown;
  guestFacingSummary: string | null;
  requiresIdentityVerification: boolean;
  requiresAgreementSignature: boolean;
  capturedAt: string;
};

function parseAgreementSnapshot(
  value: unknown
): AgreementSnapshot | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }

  const snapshot = value as Record<string, unknown>;

  if (
    typeof snapshot.agreementId !== "string" ||
    typeof snapshot.propertyId !== "string" ||
    typeof snapshot.version !== "string" ||
    typeof snapshot.title !== "string" ||
    typeof snapshot.agreementText !== "string" ||
    typeof snapshot.capturedAt !== "string"
  ) {
    return null;
  }

  return {
    agreementId: snapshot.agreementId,
    propertyId: snapshot.propertyId,
    version: snapshot.version,
    title: snapshot.title,
    agreementText: snapshot.agreementText,
    rules: snapshot.rules ?? null,
    guestFacingSummary:
      typeof snapshot.guestFacingSummary === "string"
        ? snapshot.guestFacingSummary
        : null,
    requiresIdentityVerification:
      snapshot.requiresIdentityVerification !== false,
    requiresAgreementSignature:
      snapshot.requiresAgreementSignature !== false,
    capturedAt: snapshot.capturedAt,
  };
}

function cleanLegalName(value: unknown) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function completeGuestAgreementAndStartIdentity(
  prisma: PrismaClient,
  input: {
    guestToken: string;
    legalName: string;
    guestCount: number;
    authorizedGuestAccepted: boolean;
    agreementAccepted: boolean;
    rulesAccepted: boolean;
    identityConsentAccepted: boolean;
    ipAddress?: string | null;
    userAgent?: string | null;
    returnUrl: string;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  const token = String(input.guestToken ?? "").trim();
  const legalName = cleanLegalName(input.legalName);

  if (!token) {
    throw new Error("GUEST_VERIFICATION_TOKEN_REQUIRED");
  }

  const reservation = await prisma.reservation.findFirst({
    where: {
      guestToken: token,
      guestTokenExpiresAt: {
        gt: now,
      },
    },
    select: {
      id: true,
      reservationNumber: true,
      propertyId: true,
      guestName: true,
      checkOut: true,
      paymentState: true,
      status: true,

      guestAgreementSnapshot: true,
      guestAgreementSignedAt: true,
      identityVerificationConsentAt: true,

      property: {
        select: {
          maxGuests: true,
        },
      },
    },
  });

  if (!reservation) {
    throw new Error(
      "GUEST_VERIFICATION_LINK_INVALID_OR_EXPIRED"
    );
  }

  if (!reservation.reservationNumber) {
    throw new Error(
      "GUEST_VERIFICATION_RESERVATION_NUMBER_MISSING"
    );
  }

  if (reservation.status !== ReservationStatus.ACTIVE) {
    throw new Error(
      "GUEST_VERIFICATION_RESERVATION_NOT_ACTIVE"
    );
  }

  if (reservation.paymentState !== PaymentState.PAID) {
    throw new Error(
      "GUEST_VERIFICATION_PAYMENT_NOT_PAID"
    );
  }

  if (reservation.checkOut.getTime() <= now.getTime()) {
    throw new Error(
      "GUEST_VERIFICATION_STAY_ALREADY_ENDED"
    );
  }

  const maxGuests = reservation.property.maxGuests;

  if (
    !Number.isInteger(maxGuests) ||
    Number(maxGuests) < 1
  ) {
    throw new Error(
      "GUEST_VERIFICATION_PROPERTY_MAX_GUESTS_MISSING"
    );
  }

  if (
    !Number.isInteger(input.guestCount) ||
    input.guestCount < 1 ||
    input.guestCount > Number(maxGuests)
  ) {
    throw new Error(
      "GUEST_VERIFICATION_GUEST_COUNT_INVALID"
    );
  }

  if (legalName.length < 2 || legalName.length > 120) {
    throw new Error(
      "GUEST_VERIFICATION_LEGAL_NAME_INVALID"
    );
  }

  if (!input.authorizedGuestAccepted) {
    throw new Error(
      "GUEST_VERIFICATION_AUTHORIZED_GUEST_REQUIRED"
    );
  }

  if (!input.agreementAccepted) {
    throw new Error(
      "GUEST_VERIFICATION_AGREEMENT_REQUIRED"
    );
  }

  if (!input.rulesAccepted) {
    throw new Error(
      "GUEST_VERIFICATION_RULES_REQUIRED"
    );
  }

  if (!input.identityConsentAccepted) {
    throw new Error(
      "GUEST_VERIFICATION_IDENTITY_CONSENT_REQUIRED"
    );
  }

  const snapshot = parseAgreementSnapshot(
    reservation.guestAgreementSnapshot
  );

  if (!snapshot) {
    throw new Error(
      "GUEST_VERIFICATION_AGREEMENT_SNAPSHOT_INVALID"
    );
  }

  if (snapshot.propertyId !== reservation.propertyId) {
    throw new Error(
      "GUEST_VERIFICATION_AGREEMENT_PROPERTY_MISMATCH"
    );
  }

  const acceptedAt = now.toISOString();

  const acceptance = {
    accepted: true,
    acceptedAt,
    source: "GUEST_PRECHECKIN_PORTAL",
    agreementId: snapshot.agreementId,
    agreementVersion: snapshot.version,
    agreementTitle: snapshot.title,
    agreementCapturedAt: snapshot.capturedAt,
    legalName,
    guestCount: input.guestCount,
    authorizedGuestAccepted: true,
    agreementAccepted: true,
    rulesAccepted: true,
    identityConsentAccepted: true,
    ...(input.ipAddress
      ? { ipAddress: input.ipAddress }
      : {}),
    ...(input.userAgent
      ? { userAgent: input.userAgent }
      : {}),
  };

  await prisma.reservation.update({
    where: {
      id: reservation.id,
    },
    data: {
      verificationGuestCount: input.guestCount,
      verificationCompletedByIp:
        input.ipAddress ?? null,
      verificationUserAgent:
        input.userAgent ?? null,
      verificationAcceptedRulesAt: now,

      guestAgreementAcceptance:
        acceptance as unknown as Prisma.InputJsonValue,

      guestAgreementSignedAt:
        reservation.guestAgreementSignedAt ?? now,

      identityDeclaredLegalName: legalName,
      identityVerificationConsentAt:
        reservation.identityVerificationConsentAt ?? now,
    },
  });

  const identitySession =
    await createGuestIdentityVerificationSession(
      prisma,
      {
        reservationId: reservation.id,
        returnUrl: input.returnUrl,
      }
    );

  console.log(
    "[GUEST_VERIFICATION] agreement accepted and identity ready",
    {
      reservationNumber:
        reservation.reservationNumber,
      agreementVersion: snapshot.version,
      guestCount: input.guestCount,
      identityStatus: identitySession.status,
      identitySessionReused:
        identitySession.reused,
    }
  );

  return {
    ok: true,
    reservationNumber:
      reservation.reservationNumber,
    agreementVersion: snapshot.version,
    identitySession,
  };
}