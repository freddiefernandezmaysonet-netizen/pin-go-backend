import type { PrismaClient } from "@prisma/client";

export async function markTTLockRecipientDeletePending(
  prisma: PrismaClient,
  guestPersonId: string,
  now = new Date(),
) {
  const activeCredentials = await prisma.mobileAccessCredential.count({
    where: {
      guestPersonId,
      status: { in: ["PENDING", "ACTIVE"] },
      endsAt: { gt: now },
    },
  });
  if (activeCredentials > 0) return { eligible: false as const, reason: "ACTIVE_MOBILE_CREDENTIALS" as const };

  const result = await prisma.tTLockRecipientIdentity.updateMany({
    where: { guestPersonId, status: { in: ["ACTIVE", "FAILED"] } },
    data: { status: "DELETE_PENDING", deleteRequestedAt: now },
  });
  return { eligible: result.count > 0, reason: result.count > 0 ? null : "IDENTITY_NOT_DELETABLE" as const };
}
