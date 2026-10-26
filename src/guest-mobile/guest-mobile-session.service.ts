import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { ACTIVATION_PREFIX, activationHash, activeAppStayWhere, lockAppStay } from "./ota-guest-app-activation.service.js";
import { resolveChannexOperationalProvider } from "../services/ota-guest-external-messaging.policy.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeToken(value: unknown) {
  const token = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(token)) {
    throw new Error("GUEST_MOBILE_INVALID_STAY_TOKEN");
  }
  return token;
}

function hashToken(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makeBearer() {
  return randomBytes(32).toString("base64url");
}

export async function exchangeGuestStayToken(
  prisma: PrismaClient,
  input: {
    guestToken: unknown;
    deviceLabel?: string | null;
    platform?: string | null;
    now?: Date;
  },
) {
  let guestToken = normalizeToken(input.guestToken);
  const now = input.now ?? new Date();

  return prisma.$transaction(async tx => {
    let activationId: string | undefined;
    if (guestToken.startsWith(ACTIVATION_PREFIX)) {
      const activation = await tx.guestAppActivationChallenge.findUnique({
        where: { activationTokenHash: activationHash(guestToken) },
        include: { reservation: { select: { id: true, guestToken: true } } },
      });
      if (!activation || !activation.verifiedAt || !activation.deliveredAt || activation.revokedAt || activation.consumedAt ||
          !activation.activationExpiresAt || activation.activationExpiresAt <= now || !activation.reservation.guestToken ||
          activation.guestTokenHash !== activationHash(activation.reservation.guestToken))
        throw Error("GUEST_MOBILE_ACTIVATION_REQUIRED");
      await lockAppStay(tx, activation.reservationId);
      const consumed = await tx.guestAppActivationChallenge.updateMany({
        where: { id: activation.id, consumedAt: null, revokedAt: null, activationExpiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) throw Error("GUEST_MOBILE_ACTIVATION_REQUIRED");
      activationId = activation.id;
      guestToken = activation.reservation.guestToken;
    }
    const reservation = await tx.reservation.findFirst({
      where: {
        guestToken,
        OR: [
          { guestTokenExpiresAt: null },
          { guestTokenExpiresAt: { gt: now } },
        ],
      },
      select: {
        id: true,
        reservationNumber: true,
        guestName: true,
        guestEmail: true,
        guestPhone: true,
        source: true, externalProvider: true, externalId: true,
        status: true, cancelledAt: true, checkOut: true, guestTokenExpiresAt: true,
        property: { select: { status: true } },
        guestStayLink: {
          select: {
            id: true,
            guestPersonId: true,
            revokedAt: true,
          },
        },
      },
    });

    if (!reservation || !reservation.reservationNumber) {
      throw new Error("GUEST_MOBILE_STAY_NOT_AVAILABLE");
    }

    const ota = resolveChannexOperationalProvider(reservation);
    if (ota && !activationId) throw Error("GUEST_MOBILE_ACTIVATION_REQUIRED");
    if (activationId && (!ota || reservation.status !== "ACTIVE" || reservation.cancelledAt ||
        reservation.property.status !== "ACTIVE" || reservation.checkOut <= now ||
        !reservation.guestTokenExpiresAt || reservation.guestTokenExpiresAt <= now))
      throw Error("GUEST_MOBILE_STAY_NOT_AVAILABLE");

    let guestPersonId: string;

    if (reservation.guestStayLink) {
      if (reservation.guestStayLink.revokedAt) {
        throw new Error("GUEST_MOBILE_STAY_LINK_REVOKED");
      }
      guestPersonId = reservation.guestStayLink.guestPersonId;
    } else {
      const person = await tx.guestPerson.create({
        data: {
          primaryEmail: reservation.guestEmail,
          primaryPhone: reservation.guestPhone,
          displayName: reservation.guestName,
        },
        select: { id: true },
      });

      await tx.guestStayLink.create({
        data: {
          guestPersonId: person.id,
          reservationId: reservation.id,
        },
      });

      guestPersonId = person.id;
    }

    const bearer = makeBearer();
    const expiresAt = new Date(ota
      ? Math.min(now.getTime() + SESSION_TTL_MS, +reservation.checkOut, +reservation.guestTokenExpiresAt!)
      : now.getTime() + SESSION_TTL_MS);

    const session = await tx.guestDeviceSession.create({
      data: {
        guestPersonId,
        ...(activationId ? { guestAppActivationId: activationId } : {}),
        tokenHash: hashToken(bearer),
        deviceLabel: String(input.deviceLabel ?? "").trim().slice(0, 120) || null,
        platform: String(input.platform ?? "").trim().toLowerCase().slice(0, 32) || null,
        expiresAt,
      },
      select: { id: true },
    });

    return {
      bearer,
      sessionId: session.id,
      expiresAt,
      guestPersonId,
      stay: {
        reservationNumber: reservation.reservationNumber,
      },
    };
  });
}

export async function resolveGuestMobileSession(
  prisma: PrismaClient,
  bearerValue: unknown,
  now = new Date(),
) {
  const bearer = normalizeToken(bearerValue);
  const session = await prisma.guestDeviceSession.findUnique({
    where: { tokenHash: hashToken(bearer) },
    select: {
      id: true,
      guestPersonId: true,
      expiresAt: true,
      revokedAt: true,
      guestAppActivation: { select: {
        revokedAt: true, guestTokenHash: true,
        reservation: { select: { id: true, guestToken: true } },
      } },
    },
  });

  if (!session || session.revokedAt || session.expiresAt <= now) {
    throw new Error("GUEST_MOBILE_UNAUTHENTICATED");
  }

  if (session.guestAppActivation) {
    const proof = session.guestAppActivation;
    if (proof.revokedAt || !proof.reservation.guestToken ||
        proof.guestTokenHash !== activationHash(proof.reservation.guestToken) ||
        !await prisma.reservation.findFirst({ where: { id: proof.reservation.id, ...activeAppStayWhere(now) }, select: { id: true } }))
      throw Error("GUEST_MOBILE_UNAUTHENTICATED");
  } else {
    // Legacy OTA sessions are not grandfathered into access after this fix.
    const stays = await prisma.guestStayLink.findMany({
      where: { guestPersonId: session.guestPersonId },
      select: { reservation: { select: { source: true, externalProvider: true, externalId: true } } },
    });
    if (stays.some(stay => resolveChannexOperationalProvider(stay.reservation)))
      throw Error("GUEST_MOBILE_UNAUTHENTICATED");
  }

  return session;
}

export async function authorizeGuestMobileStay(
  prisma: PrismaClient,
  input: {
    guestPersonId: string;
    reservationNumber: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const link = await prisma.guestStayLink.findFirst({
    where: {
      guestPersonId: input.guestPersonId,
      revokedAt: null,
      reservation: {
        reservationNumber: input.reservationNumber,
      },
    },
    select: {
      reservation: {
        select: {
          id: true,
          reservationNumber: true,
          status: true,
          checkIn: true,
          checkOut: true,
          guestTokenExpiresAt: true,
        },
      },
    },
  });

  if (!link?.reservation?.reservationNumber) {
    throw new Error("GUEST_MOBILE_STAY_NOT_AUTHORIZED");
  }

  return {
    reservationId: link.reservation.id,
    reservationNumber: link.reservation.reservationNumber,
    status: link.reservation.status,
    checkIn: link.reservation.checkIn,
    checkOut: link.reservation.checkOut,
    stayEnded: link.reservation.checkOut <= now,
  };
}

export async function readGuestMobileStay(
  prisma: PrismaClient,
  input: { guestPersonId: string; reservationNumber: string },
) {
  const link = await prisma.guestStayLink.findFirst({
    where: {
      guestPersonId: input.guestPersonId,
      revokedAt: null,
      reservation: { reservationNumber: input.reservationNumber },
    },
    select: {
      reservation: {
        select: {
          reservationNumber: true,
          status: true,
          preferredLanguage: true,
          checkIn: true,
          checkOut: true,
          verificationStatus: true,
          guestAccessReleaseStatus: true,
          property: {
            select: { name: true, timezone: true },
          },
          guestJourney: {
            select: { currentState: true },
          },
        },
      },
    },
  });

  if (!link?.reservation?.reservationNumber) {
    throw new Error("GUEST_MOBILE_STAY_NOT_AUTHORIZED");
  }

  const stay = link.reservation;
  return {
    reservationNumber: stay.reservationNumber,
    status: stay.status,
    preferredLanguage: stay.preferredLanguage,
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    verificationStatus: stay.verificationStatus,
    accessReleaseStatus: stay.guestAccessReleaseStatus,
    guestJourneyState: stay.guestJourney?.currentState ?? null,
    property: {
      name: stay.property.name,
      timezone: stay.property.timezone,
    },
  };
}

export async function resolveGuestMobilePinAIScope(
  prisma: PrismaClient,
  input: { guestPersonId: string; reservationNumber: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const link = await prisma.guestStayLink.findFirst({
    where: {
      guestPersonId: input.guestPersonId,
      revokedAt: null,
      reservation: {
        reservationNumber: input.reservationNumber,
        status: "ACTIVE",
        property: { status: "ACTIVE" },
      },
    },
    select: {
      reservation: {
        select: {
          id: true,
          propertyId: true,
          guestToken: true,
          guestTokenExpiresAt: true,
          property: { select: { organizationId: true } },
        },
      },
    },
  });

  const reservation = link?.reservation;
  if (
    !reservation?.guestToken ||
    !reservation.guestTokenExpiresAt ||
    reservation.guestTokenExpiresAt <= now
  ) {
    throw new Error("GUEST_MOBILE_PIN_AI_NOT_AVAILABLE");
  }

  return {
    reservationId: reservation.id,
    propertyId: reservation.propertyId,
    organizationId: reservation.property.organizationId,
    guestToken: reservation.guestToken,
  };
}
