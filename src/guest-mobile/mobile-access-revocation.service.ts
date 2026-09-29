import type { PrismaClient } from "@prisma/client";
import type { MobileAccessProvider } from "./mobile-access-provider.js";

export async function revokeMobileAccessCredential(
  prisma: PrismaClient,
  provider: MobileAccessProvider,
  credentialId: string,
  now = new Date(),
) {
  const credential = await prisma.mobileAccessCredential.findUnique({
    where: { id: credentialId },
    select: {
      id: true,
      status: true,
      providerKeyId: true,
      lock: { select: { ttlockLockId: true } },
    },
  });
  if (!credential) return { ok: true as const, skipped: "NOT_FOUND" as const };
  if (credential.status === "REVOKED" || credential.status === "EXPIRED") {
    return { ok: true as const, skipped: "ALREADY_INACTIVE" as const };
  }

  if (credential.providerKeyId) {
    if (!credential.lock.ttlockLockId) throw new Error("MOBILE_ACCESS_PROVIDER_LOCK_MISSING");
    try {
      await provider.revokeKey({
        providerKeyId: credential.providerKeyId,
        providerLockId: credential.lock.ttlockLockId,
      });
    } catch (error) {
      await prisma.mobileAccessCredential.update({
        where: { id: credential.id },
        data: { lastError: error instanceof Error ? error.message.slice(0, 500) : "MOBILE_ACCESS_REVOKE_FAILED" },
      });
      throw error;
    }
  }

  await prisma.mobileAccessCredential.update({
    where: { id: credential.id },
    data: {
      status: "REVOKED",
      revokedAt: now,
      lockDataCiphertext: null,
      lockDataKeyVersion: null,
      lastError: null,
    },
  });

  return { ok: true as const, revoked: true as const };
}
