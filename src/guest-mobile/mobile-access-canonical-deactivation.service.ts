import { prisma } from "../lib/prisma.js";
import { deactivateGrant } from "../services/ttlock/ttlock.brain.js";
import { reconcileMobileAccessRevocationSidecar } from "./mobile-access-revocation-sidecar.service.js";
import { revokeMobileAccessCredential } from "./mobile-access-revocation.service.js";
import { TTLockMobileAccessProvider } from "./ttlock-mobile-access-provider.js";

export async function deactivateGuestAccess(accessGrantId: string) {
  const canonical = await deactivateGrant(accessGrantId);

  if (process.env.MOBILE_ACCESS_EKEY_ENABLED !== "true") {
    return { canonical, mobile: { status: "DISABLED" as const } };
  }

  const scope = await prisma.accessGrant.findUnique({
    where: { id: accessGrantId },
    select: {
      lock: { select: { property: { select: { organizationId: true } } } },
    },
  });
  if (!scope?.lock?.property?.organizationId) {
    return { canonical, mobile: { status: "RECOVERY_REQUIRED" as const, error: "MOBILE_ACCESS_ORGANIZATION_SCOPE_MISSING" } };
  }

  const mobile = await reconcileMobileAccessRevocationSidecar(prisma, {
    accessGrantId,
    revokeCredential: async credentialId => {
      const credential = await prisma.mobileAccessCredential.findUnique({
        where: { id: credentialId },
        select: {
          id: true,
          guestPerson: { select: { ttlockRecipientIdentity: { select: { id: true } } } },
        },
      });
      const identityId = credential?.guestPerson.ttlockRecipientIdentity?.id;
      if (!identityId) throw new Error("TTLOCK_RECIPIENT_IDENTITY_MISSING");

      const provider = new TTLockMobileAccessProvider(
        prisma,
        scope.lock.property.organizationId,
        identityId,
      );
      await revokeMobileAccessCredential(prisma, provider, credential.id);
    },
  });

  return { canonical, mobile };
}
