import type { PrismaClient } from "@prisma/client";

export async function reconcileMobileAccessRevocationSidecar(
  prisma: PrismaClient,
  input: Readonly<{
    accessGrantId: string;
    revokeCredential: (credentialId: string) => Promise<unknown>;
  }>,
) {
  const credentials = await prisma.mobileAccessCredential.findMany({
    where: {
      accessGrantId: input.accessGrantId,
      status: { in: ["PENDING", "ACTIVE"] },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  const revoked: string[] = [];
  const failed: string[] = [];
  for (const credential of credentials) {
    try {
      await input.revokeCredential(credential.id);
      revoked.push(credential.id);
    } catch {
      failed.push(credential.id);
    }
  }

  return failed.length === 0
    ? { status: "REVOKED" as const, revokedCredentialIds: revoked, failedCredentialIds: failed }
    : { status: "RECOVERY_REQUIRED" as const, revokedCredentialIds: revoked, failedCredentialIds: failed };
}
