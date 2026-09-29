import type { PrismaClient } from "@prisma/client";

export type RevokeMobileCredentialFn = (credentialId: string) => Promise<unknown>;

export async function revokeMobileAccessForGrant(
  prisma: PrismaClient,
  input: Readonly<{ accessGrantId: string; revokeCredential: RevokeMobileCredentialFn }>,
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
  for (const credential of credentials) {
    await input.revokeCredential(credential.id);
    revoked.push(credential.id);
  }

  return { ok: true as const, revokedCredentialIds: revoked };
}
