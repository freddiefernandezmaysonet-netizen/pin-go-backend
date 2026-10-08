import type { PrismaClient } from "@prisma/client";

export async function findMobileAccessRevocationsDue(
  prisma: PrismaClient,
  now = new Date(),
  limit = 25,
) {
  return prisma.mobileAccessCredential.findMany({
    where: {
      status: { in: ["PENDING", "ACTIVE"] },
      recoveryExhaustedAt: null,
      OR: [
        { endsAt: { lte: now } },
        { accessGrant: { status: { in: ["REVOKED", "FAILED"] } } },
        { reservation: { status: "CANCELLED" } },
        { guestDeviceSession: { revokedAt: { not: null } } },
      ],
    },
    select: {
      id: true,
      accessGrantId: true,
      guestPersonId: true,
      lockId: true,
      recoveryNextAttemptAt: true,
    },
    orderBy: { endsAt: "asc" },
    take: Math.min(Math.max(limit, 1), 100),
  });
}
