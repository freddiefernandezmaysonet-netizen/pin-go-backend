import type { PrismaClient } from "@prisma/client";

export class MobileAccessEligibilityError extends Error {
  constructor(readonly code:
    | "SESSION_NOT_FOUND"
    | "STAY_NOT_LINKED"
    | "ACCESS_NOT_RELEASED"
    | "GRANT_NOT_ACTIVE"
    | "WINDOW_NOT_ACTIVE"
    | "LOCK_NOT_AVAILABLE") {
    super(`MOBILE_ACCESS_${code}`);
  }
}

export async function resolveMobileAccessEligibility(
  prisma: PrismaClient,
  input: Readonly<{ guestDeviceSessionId: string; reservationId: string; now?: Date }>,
) {
  const now = input.now ?? new Date();
  const session = await prisma.guestDeviceSession.findFirst({
    where: { id: input.guestDeviceSessionId, revokedAt: null, expiresAt: { gt: now } },
    select: { id: true, guestPersonId: true },
  });
  if (!session) throw new MobileAccessEligibilityError("SESSION_NOT_FOUND");

  const stay = await prisma.guestStayLink.findFirst({
    where: { guestPersonId: session.guestPersonId, reservationId: input.reservationId, revokedAt: null },
    select: {
      reservation: {
        select: {
          id: true,
          guestAccessReleaseStatus: true,
          accessGrants: {
            where: { type: "GUEST", status: "ACTIVE", startsAt: { lte: now }, endsAt: { gt: now } },
            select: {
              id: true, lockId: true, startsAt: true, endsAt: true,
              lock: { select: { ttlockLockId: true, isActive: true } },
            },
          },
        },
      },
    },
  });
  if (!stay?.reservation) throw new MobileAccessEligibilityError("STAY_NOT_LINKED");
  if (stay.reservation.guestAccessReleaseStatus !== "RELEASED") throw new MobileAccessEligibilityError("ACCESS_NOT_RELEASED");

  const grant = stay.reservation.accessGrants[0];
  if (!grant) throw new MobileAccessEligibilityError("GRANT_NOT_ACTIVE");
  if (!(grant.startsAt <= now && grant.endsAt > now)) throw new MobileAccessEligibilityError("WINDOW_NOT_ACTIVE");
  if (!grant.lock.isActive || !grant.lock.ttlockLockId) throw new MobileAccessEligibilityError("LOCK_NOT_AVAILABLE");

  return {
    guestPersonId: session.guestPersonId,
    guestDeviceSessionId: session.id,
    reservationId: stay.reservation.id,
    accessGrantId: grant.id,
    lockId: grant.lockId,
    providerLockId: grant.lock.ttlockLockId,
    startsAt: grant.startsAt,
    endsAt: grant.endsAt,
  };
}
