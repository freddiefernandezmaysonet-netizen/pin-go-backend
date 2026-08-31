import {
  AccessGrantType,
  AccessMethod,
  AccessStatus,
  GuestAccessReleaseStatus,
  PrismaClient,
} from "@prisma/client";

import {
  buildGuestAccessCommunicationOutbox,
  filterAlreadyOwnedGuestAccessDeliveries,
} from "./guest-journey-access-communications-bridge.policy";

export type MaterializeGuestAccessCommunicationOutboxInput = {
  reservationId: string;
  organizationId: string;
  propertyId: string;
  accessGrantIds: string[];
};

export type MaterializeGuestAccessCommunicationOutboxResult = {
  canonicalAccessGrantId: string | null;
  proposed: number;
  created: number;
  deduplicated: number;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export async function materializeGuestAccessCommunicationOutbox(
  prisma: PrismaClient,
  input: MaterializeGuestAccessCommunicationOutboxInput
): Promise<MaterializeGuestAccessCommunicationOutboxResult> {
  const reservationId = clean(input.reservationId);
  const organizationId = clean(input.organizationId);
  const propertyId = clean(input.propertyId);
  if (!reservationId || !organizationId || !propertyId) {
    throw new Error("ACCESS_COMMUNICATIONS_OUTBOX_SCOPE_REQUIRED");
  }

  const accessGrantIds = [...new Set(input.accessGrantIds.map(clean).filter(Boolean))];
  if (accessGrantIds.length === 0) {
    throw new Error("ACCESS_COMMUNICATIONS_OUTBOX_ACCESS_GRANT_REQUIRED");
  }

  const reservation = await prisma.reservation.findFirst({
    where: {
      id: reservationId,
      propertyId,
      property: { organizationId },
    },
    select: {
      id: true,
      reservationNumber: true,
      guestEmail: true,
      guestPhone: true,
      preferredLanguage: true,
      externalRaw: true,
      checkIn: true,
      checkOut: true,
      guestAccessReleaseStatus: true,
      guestAccessReleasedAt: true,
      accessGrants: {
        where: {
          id: { in: accessGrantIds },
          type: AccessGrantType.GUEST,
        },
        select: {
          id: true,
          method: true,
          status: true,
          startsAt: true,
          endsAt: true,
          lastAppliedAt: true,
          secureAccessCode: {
            select: {
              accessCodeHash: true,
            },
          },
        },
      },
    },
  });

  if (!reservation) {
    throw new Error("ACCESS_COMMUNICATIONS_OUTBOX_RESERVATION_SCOPE_MISMATCH");
  }
  if (
    reservation.guestAccessReleaseStatus !== GuestAccessReleaseStatus.RELEASED ||
    !reservation.guestAccessReleasedAt
  ) {
    throw new Error("ACCESS_COMMUNICATIONS_OUTBOX_RELEASE_EVIDENCE_MISSING");
  }

  const canonical = reservation.accessGrants.filter((grant) =>
    grant.method === AccessMethod.PASSCODE_TIMEBOUND &&
    grant.status === AccessStatus.ACTIVE &&
    grant.startsAt.getTime() === reservation.checkIn.getTime() &&
    grant.endsAt.getTime() === reservation.checkOut.getTime() &&
    Boolean(grant.lastAppliedAt) &&
    Boolean(clean(grant.secureAccessCode?.accessCodeHash))
  );
  if (canonical.length !== 1) {
    throw new Error("ACCESS_COMMUNICATIONS_OUTBOX_CANONICAL_GRANT_MISSING_OR_AMBIGUOUS");
  }

  const grant = canonical[0];
  const rows = buildGuestAccessCommunicationOutbox({
    organizationId,
    propertyId,
    reservationId,
    reservationNumber: reservation.reservationNumber,
    guestEmail: reservation.guestEmail,
    guestPhone: reservation.guestPhone,
    preferredLanguage: reservation.preferredLanguage,
    externalRaw: reservation.externalRaw,
    accessGrantId: grant.id,
    accessCodeHash: grant.secureAccessCode!.accessCodeHash,
    validFrom: grant.startsAt,
    validUntil: grant.endsAt,
  });

  const existing = await prisma.messageLog.findMany({
    where: {
      reservationId,
      organizationId,
      propertyId,
      communicationType: "GUEST_ACCESS_PASSCODE",
    },
    select: {
      channel: true,
      to: true,
      status: true,
      accessGrantId: true,
      body: true,
      createdAt: true,
    },
  });

  const pendingRows = filterAlreadyOwnedGuestAccessDeliveries({
    rows,
    existing,
    accessGrantId: grant.id,
    credentialAppliedAt: grant.lastAppliedAt!,
  });

  if (pendingRows.length === 0) {
    return {
      canonicalAccessGrantId: grant.id,
      proposed: rows.length,
      created: 0,
      deduplicated: rows.length,
    };
  }

  const created = await prisma.messageLog.createMany({
    data: pendingRows,
    skipDuplicates: true,
  });

  return {
    canonicalAccessGrantId: grant.id,
    proposed: rows.length,
    created: created.count,
    deduplicated: rows.length - created.count,
  };
}
