import type { PrismaClient } from "@prisma/client";
import { revokeMobileAccessCredential } from "./mobile-access-revocation.service.js";
import { TTLockMobileAccessProvider } from "./ttlock-mobile-access-provider.js";

export async function revokeMobileAccessCredentialById(
  prisma: PrismaClient,
  credentialId: string,
  now = new Date(),
) {
  const scope = await prisma.mobileAccessCredential.findUnique({
    where: { id: credentialId },
    select: {
      id: true,
      provider: true,
      reservation: {
        select: {
          property: {
            select: { organizationId: true },
          },
        },
      },
    },
  });

  if (!scope) {
    return { ok: true as const, skipped: "NOT_FOUND" as const };
  }

  if (scope.provider !== "TTLOCK") {
    throw new Error("MOBILE_ACCESS_PROVIDER_UNSUPPORTED");
  }

  const provider = new TTLockMobileAccessProvider(
    prisma,
    scope.reservation.property.organizationId,
  );

  return revokeMobileAccessCredential(prisma, provider, scope.id, now);
}
