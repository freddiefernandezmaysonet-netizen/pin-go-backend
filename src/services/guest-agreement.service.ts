import {
  Prisma,
  PrismaClient,
} from "@prisma/client";

export type GuestAgreementSnapshot = {
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
  const reservation = await prisma.reservation.findUnique({
    where: {
      id: reservationId,
    },
    select: {
      id: true,
      propertyId: true,
      guestAgreementSnapshot: true,
    },
  });

  if (!reservation) {
    throw new Error("GUEST_AGREEMENT_RESERVATION_NOT_FOUND");
  }

  if (reservation.guestAgreementSnapshot) {
    return {
      ok: true,
      alreadyCaptured: true,
      snapshot: reservation.guestAgreementSnapshot,
    };
  }

  const agreement = await getActivePropertyGuestAgreement(
    prisma,
    reservation.propertyId
  );

  if (!agreement) {
    return {
      ok: false,
      alreadyCaptured: false,
      reason: "ACTIVE_PROPERTY_GUEST_AGREEMENT_NOT_FOUND",
      snapshot: null,
    };
  }

  const snapshot: GuestAgreementSnapshot = {
    agreementId: agreement.id,
    propertyId: agreement.propertyId,
    version: agreement.version,
    title: agreement.title,
    agreementText: agreement.agreementText,
    rules: agreement.rules ?? null,
    guestFacingSummary:
      agreement.guestFacingSummary ?? null,
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