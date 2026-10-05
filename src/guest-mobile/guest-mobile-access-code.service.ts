import type { PrismaClient } from "@prisma/client";
import { decryptAccessCode, hashAccessCode } from "../services/access-code-crypto.service.js";

// Read only. RELEASED remains the Access Engine's authority; this never provisions a code.
export async function readGuestMobileAccessCodes(
  prisma: PrismaClient,
  input: { guestPersonId: string; reservationNumber: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const link = await prisma.guestStayLink.findFirst({
    where: {
      guestPersonId: input.guestPersonId,
      revokedAt: null,
      reservation: { reservationNumber: input.reservationNumber },
    },
    select: { reservation: { select: {
      status: true, checkOut: true, guestAccessReleaseStatus: true,
      property: { select: { id: true, status: true, timezone: true } },
      accessGrants: {
        where: { type: "GUEST", method: "PASSCODE_TIMEBOUND", status: "ACTIVE", startsAt: { lte: now }, endsAt: { gt: now } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true, startsAt: true, endsAt: true, desiredStartsAt: true, desiredEndsAt: true,
          ttlockKeyboardPwdId: true, unlockKey: true,
          lock: { select: { id: true, displayName: true, locationLabel: true, propertyId: true, isActive: true, ttlockLockId: true } },
          secureAccessCode: { select: {
            accessGrantId: true, lockId: true, keyboardPwdId: true, method: true,
            startDate: true, endDate: true, expiresAt: true, accessCodeEnc: true, accessCodeHash: true,
          } },
        },
      },
    } } },
  });
  if (!link) throw new Error("GUEST_MOBILE_STAY_NOT_AUTHORIZED");
  const stay = link.reservation;
  const unavailable = { status: "UNAVAILABLE" as const, codes: [] };
  if (stay.status !== "ACTIVE" || stay.property.status !== "ACTIVE" ||
      stay.checkOut <= now || stay.guestAccessReleaseStatus !== "RELEASED") return unavailable;

  const eligible = stay.accessGrants.filter(grant => {
    const code = grant.secureAccessCode;
    return grant.lock.isActive && grant.lock.propertyId === stay.property.id &&
      grant.startsAt <= now && grant.endsAt > now &&
      (!grant.desiredStartsAt || +grant.desiredStartsAt === +grant.startsAt) &&
      (!grant.desiredEndsAt || +grant.desiredEndsAt === +grant.endsAt) &&
      code?.accessCodeEnc && code.accessGrantId === grant.id && code.method === "period" &&
      String(code.lockId) === String(grant.lock.ttlockLockId) &&
      grant.ttlockKeyboardPwdId != null && code.keyboardPwdId === String(grant.ttlockKeyboardPwdId) &&
      code.startDate === BigInt(+grant.startsAt) && code.endDate === BigInt(+grant.endsAt) &&
      code.expiresAt > now;
  });
  // Multiple active codes for the same door are ambiguous: do not choose one arbitrarily.
  if (new Set(eligible.map(g => g.lock.id)).size !== eligible.length) return unavailable;
  const codes = eligible.map(grant => {
    const secure = grant.secureAccessCode!;
    const code = decryptAccessCode(secure.accessCodeEnc!);
    if (!/^\d{4,12}$/.test(code) || hashAccessCode(code) !== secure.accessCodeHash) {
      throw new Error("GUEST_MOBILE_ACCESS_CODE_UNAVAILABLE");
    }
    return {
      doorName: grant.lock.displayName || grant.lock.locationLabel || "",
      code,
      unlockKey: grant.unlockKey === "#" ? "#" : null,
      startsAt: grant.startsAt.toISOString(),
      endsAt: new Date(Math.min(+grant.endsAt, +secure.expiresAt, +stay.checkOut)).toISOString(),
      timezone: stay.property.timezone,
    };
  });
  return codes.length ? { status: "AVAILABLE" as const, codes } : unavailable;
}
