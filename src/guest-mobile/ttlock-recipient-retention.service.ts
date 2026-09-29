import type { PrismaClient } from "@prisma/client";

const DAY_MS = 24 * 60 * 60 * 1000;

export function ttlockRecipientRetentionDays() {
  const value = Number(process.env.TTLOCK_RECIPIENT_RETENTION_DAYS ?? 365);
  return Number.isInteger(value) && value >= 180 && value <= 730 ? value : 365;
}

export async function evaluateTTLockRecipientRetention(
  prisma: PrismaClient,
  identityId: string,
  now = new Date(),
) {
  const identity = await prisma.tTLockRecipientIdentity.findUnique({
    where: { id: identityId },
    select: { id: true, guestPersonId: true, status: true, lastActivityAt: true, registeredAt: true, createdAt: true },
  });
  if (!identity || identity.status !== "ACTIVE") return { eligible: false as const, reason: "IDENTITY_NOT_ACTIVE" as const };

  const activityAt = identity.lastActivityAt ?? identity.registeredAt ?? identity.createdAt;
  const cutoff = new Date(now.getTime() - ttlockRecipientRetentionDays() * DAY_MS);
  if (activityAt > cutoff) return { eligible: false as const, reason: "RETENTION_NOT_DUE" as const };

  const [activeCredentials, futureStays] = await Promise.all([
    prisma.mobileAccessCredential.count({
      where: { guestPersonId: identity.guestPersonId, status: { in: ["PENDING", "ACTIVE"] }, endsAt: { gt: now } },
    }),
    prisma.guestStayLink.count({
      where: {
        guestPersonId: identity.guestPersonId,
        revokedAt: null,
        reservation: { status: "ACTIVE", checkOut: { gt: now } },
      },
    }),
  ]);

  if (activeCredentials > 0) return { eligible: false as const, reason: "ACTIVE_MOBILE_CREDENTIALS" as const };
  if (futureStays > 0) return { eligible: false as const, reason: "FUTURE_OR_ACTIVE_STAY" as const };

  await prisma.tTLockRecipientIdentity.update({
    where: { id: identity.id },
    data: { status: "DELETE_PENDING", deleteRequestedAt: now },
  });
  return { eligible: true as const, reason: null };
}

export async function tombstoneDeletedTTLockRecipient(
  prisma: PrismaClient,
  identityId: string,
  now = new Date(),
) {
  await prisma.tTLockRecipientIdentity.update({
    where: { id: identityId },
    data: {
      status: "DELETED",
      deletedAt: now,
      passwordCiphertext: null,
      passwordKeyVersion: null,
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
      tokenKeyVersion: null,
      tokenExpiresAt: null,
      lastError: null,
    },
  });
}
