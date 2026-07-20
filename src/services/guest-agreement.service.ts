import {
  Prisma,
  PrismaClient,
} from "@prisma/client";

type GuestLanguage = "en" | "es";

export type GuestAgreementSnapshot = {
  agreementId: string;
  propertyId: string;
  version: string;
  language: GuestLanguage;
  title: string;
  agreementText: string;
  rules: unknown;
  guestFacingSummary: string | null;
  requiresIdentityVerification: boolean;
  requiresAgreementSignature: boolean;
  capturedAt: string;
};

function resolveGuestLanguage(
  value: string | null | undefined
): GuestLanguage {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();

  return normalized.startsWith("es")
    ? "es"
    : "en";
}

function resolveLocalizedText({
  language,
  english,
  spanish,
  legacy,
}: {
  language: GuestLanguage;
  english: string | null | undefined;
  spanish: string | null | undefined;
  legacy: string;
}) {
  if (language === "es") {
    return (
      spanish?.trim() ||
      english?.trim() ||
      legacy
    );
  }

  return english?.trim() || legacy;
}

function resolveLocalizedOptionalText({
  language,
  english,
  spanish,
  legacy,
}: {
  language: GuestLanguage;
  english: string | null | undefined;
  spanish: string | null | undefined;
  legacy: string | null;
}) {
  if (language === "es") {
    return (
      spanish?.trim() ||
      english?.trim() ||
      legacy ||
      null
    );
  }

  return english?.trim() || legacy || null;
}

function resolveLocalizedRules({
  language,
  english,
  spanish,
  legacy,
}: {
  language: GuestLanguage;
  english: unknown;
  spanish: unknown;
  legacy: unknown;
}) {
  if (language === "es") {
    return spanish ?? english ?? legacy ?? null;
  }

  return english ?? legacy ?? null;
}

export async function getActivePropertyGuestAgreement(
  prisma: PrismaClient,
  propertyId: string
) {
  return prisma.propertyGuestAgreement.findFirst({
    where: {
      propertyId,
      isActive: true,
    },
    orderBy: {
      updatedAt: "desc",
    },
  });
}

export async function ensureReservationGuestAgreementSnapshot(
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
        propertyId: true,
        preferredLanguage: true,
        guestAgreementSnapshot: true,
      },
    });

  if (!reservation) {
    throw new Error(
      "GUEST_AGREEMENT_RESERVATION_NOT_FOUND"
    );
  }

  if (reservation.guestAgreementSnapshot) {
    return {
      ok: true,
      alreadyCaptured: true,
      snapshot:
        reservation.guestAgreementSnapshot,
    };
  }

  const agreement =
    await getActivePropertyGuestAgreement(
      prisma,
      reservation.propertyId
    );

  if (!agreement) {
    return {
      ok: false,
      alreadyCaptured: false,
      reason:
        "ACTIVE_PROPERTY_GUEST_AGREEMENT_NOT_FOUND",
      snapshot: null,
    };
  }

  const language = resolveGuestLanguage(
    reservation.preferredLanguage
  );

  const snapshot: GuestAgreementSnapshot = {
    agreementId: agreement.id,
    propertyId: agreement.propertyId,
    version: agreement.version,
    language,

    title: resolveLocalizedText({
      language,
      english: agreement.titleEn,
      spanish: agreement.titleEs,
      legacy: agreement.title,
    }),

    agreementText: resolveLocalizedText({
      language,
      english: agreement.agreementTextEn,
      spanish: agreement.agreementTextEs,
      legacy: agreement.agreementText,
    }),

    rules: resolveLocalizedRules({
      language,
      english: agreement.rulesEn,
      spanish: agreement.rulesEs,
      legacy: agreement.rules,
    }),

    guestFacingSummary:
      resolveLocalizedOptionalText({
        language,
        english:
          agreement.guestFacingSummaryEn,
        spanish:
          agreement.guestFacingSummaryEs,
        legacy:
          agreement.guestFacingSummary,
      }),

    requiresIdentityVerification:
      agreement.requiresIdentityVerification,

    requiresAgreementSignature:
      agreement.requiresAgreementSignature,

    capturedAt: new Date().toISOString(),
  };

  await prisma.reservation.update({
    where: {
      id: reservation.id,
    },
    data: {
      guestAgreementSnapshot:
        snapshot as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    ok: true,
    alreadyCaptured: false,
    snapshot,
  };
}