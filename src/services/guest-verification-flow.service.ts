import {
  PaymentState,
  Prisma,
  PrismaClient,
  ReservationStatus,
} from "@prisma/client";
import {
  createGuestIdentityVerificationSession,
} from "./guest-identity-verification.service";
import {
  buildGuestCancellationTermsText,
} from "./cancellation-policy.service";
import { completeGuestJourneyVerification } from "./guest-journey.service";
import { evaluateGuestAccessReadiness } from "./guest-access-readiness.service";

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

function readJsonObject(
  value: unknown
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return {};
  }

  return {
    ...(value as Record<
      string,
      unknown
    >),
  };
}

function readExistingSmsConsent(
  externalRaw: unknown
) {
  const raw =
    readJsonObject(externalRaw);

  const consent =
    readJsonObject(raw.consent);

  return consent.smsConsent === true;
}

function readExistingCancellationAcceptance(
  cancellationPolicySnapshot: unknown
) {
  const snapshot =
    readJsonObject(
      cancellationPolicySnapshot
    );

  const acceptance =
    readJsonObject(
      snapshot.cancellationTermsAcceptance
    );

  return acceptance.accepted === true
    ? acceptance
    : null;
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
    cancellationTermsAccepted: boolean;
    smsConsent: boolean;
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
      guestPhone: true,
      externalRaw: true,
      cancellationPolicySnapshot: true,
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

   const cancellationPolicySnapshot =
    readJsonObject(
      reservation.cancellationPolicySnapshot
    );

  if (
    Object.keys(
      cancellationPolicySnapshot
    ).length === 0
  ) {
    throw new Error(
      "GUEST_VERIFICATION_CANCELLATION_POLICY_SNAPSHOT_MISSING"
    );
  }

  const existingCancellationAcceptance =
    readExistingCancellationAcceptance(
      cancellationPolicySnapshot
    );

  if (
    !existingCancellationAcceptance &&
    !input.cancellationTermsAccepted
  ) {
    throw new Error(
      "GUEST_VERIFICATION_CANCELLATION_TERMS_REQUIRED"
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

  if (
    snapshot.requiresIdentityVerification &&
    !input.identityConsentAccepted
  ) {
    throw new Error(
      "GUEST_VERIFICATION_IDENTITY_CONSENT_REQUIRED"
    );
  }

  if (
    input.smsConsent &&
    !reservation.guestPhone
  ) {
    throw new Error(
      "GUEST_VERIFICATION_SMS_PHONE_REQUIRED"
    );
  }

  const acceptedAt =
    now.toISOString();

  const cancellationTermsAcceptance =
    existingCancellationAcceptance ?? {
      accepted: true,
      acceptedAt,
      text:
        buildGuestCancellationTermsText(
          cancellationPolicySnapshot
        ),
      source:
        "MANUAL_SECURE_PRECHECKIN_FORM",
      version:
        "cancellation_terms_ack_v1",
      refundBasis:
        typeof cancellationPolicySnapshot.refundBasis ===
        "string"
          ? cancellationPolicySnapshot.refundBasis
          : null,
    };

  const acceptedCancellationPolicySnapshot =
    {
      ...cancellationPolicySnapshot,
      guestAcceptedCancellationTerms:
        true,
      guestAcceptedCancellationTermsAt:
        cancellationTermsAcceptance.acceptedAt,
      guestAcceptedCancellationTermsText:
        cancellationTermsAcceptance.text,
      guestAcceptedCancellationTermsSource:
        cancellationTermsAcceptance.source,
      cancellationTermsAckVersion:
        cancellationTermsAcceptance.version,
      cancellationTermsAcceptance,
    };

  const existingExternalRaw =
    readJsonObject(
      reservation.externalRaw
    );

  const existingConsent =
    readJsonObject(
      existingExternalRaw.consent
    );

  const previouslyConsented =
    readExistingSmsConsent(
      existingExternalRaw
    );

  const effectiveSmsConsent =
    previouslyConsented ||
    input.smsConsent;

  const consentSource =
    previouslyConsented &&
    typeof existingConsent.consentSource ===
      "string"
      ? existingConsent.consentSource
      : "MANUAL_SECURE_PRECHECKIN_FORM";

  const consentAcceptedAt =
    previouslyConsented &&
    typeof existingConsent.acceptedAt ===
      "string"
      ? existingConsent.acceptedAt
      : effectiveSmsConsent
      ? acceptedAt
      : null;

  const updatedExternalRaw = {
    ...existingExternalRaw,
    consent: {
      ...existingConsent,
      stayNotificationsConsent:
        effectiveSmsConsent,
      smsConsent:
        effectiveSmsConsent,
      consentSource,
      consentVersion:
        "stay_notifications_v1",
      acceptedAt:
        consentAcceptedAt,
    },
    cancellationTerms:
      cancellationTermsAcceptance,
  };

   const acceptance = {
    accepted: true,
    acceptedAt,
    source:
      "GUEST_PRECHECKIN_PORTAL",
    agreementId:
      snapshot.agreementId,
    agreementVersion:
      snapshot.version,
    agreementTitle:
      snapshot.title,
    agreementCapturedAt:
      snapshot.capturedAt,
    legalName,
    guestCount:
      input.guestCount,
    authorizedGuestAccepted:
      true,
    agreementAccepted:
      true,
    rulesAccepted:
      true,
    identityConsentAccepted:
      snapshot.requiresIdentityVerification
        ? input.identityConsentAccepted
        : false,
    cancellationTermsAccepted:
      true,
    smsConsent:
      effectiveSmsConsent,
    ...(input.ipAddress
      ? {
          ipAddress:
            input.ipAddress,
        }
      : {}),
    ...(input.userAgent
      ? {
          userAgent:
            input.userAgent,
        }
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
      verificationAcceptedRulesAt:
        now,
      cancellationPolicySnapshot:
        acceptedCancellationPolicySnapshot as unknown as Prisma.InputJsonValue,

      externalRaw:
        updatedExternalRaw as unknown as Prisma.InputJsonValue,
        guestAgreementAcceptance:
        acceptance as unknown as Prisma.InputJsonValue,

      guestAgreementSignedAt:
        reservation.guestAgreementSignedAt ??
        now,
      identityDeclaredLegalName: legalName,
      ...(snapshot.requiresIdentityVerification
        ? {
            identityVerificationConsentAt:
              reservation.identityVerificationConsentAt ?? now,
          }
        : {
            verificationStatus: "NOT_REQUIRED",
            verifiedAt: null,
            identityVerificationConsentAt: null,
          }),
    },
  });

  if (!snapshot.requiresIdentityVerification) {
    const guestJourney = await completeGuestJourneyVerification(
      prisma,
      reservation.id
    );
    const readiness = await evaluateGuestAccessReadiness(
      prisma,
      reservation.id,
      {
        persist: true,
        now,
      }
    );

    return {
      ok: true,
      reservationNumber: reservation.reservationNumber,
      agreementVersion: snapshot.version,
      identitySession: {
        ok: true,
        alreadyVerified: false,
        reused: false,
        notRequired: true,
        reservationNumber: reservation.reservationNumber,
        verificationSessionId: null,
        status: "not_required",
        url: null,
      },
      guestJourney,
      readiness,
    };
  }

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
