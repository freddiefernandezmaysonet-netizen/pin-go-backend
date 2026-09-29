import type { PrismaClient } from "@prisma/client";

export async function runDueMobileAccessRecovery(
  prisma: PrismaClient,
  input: Readonly<{
    now?: Date;
    limit?: number;
    revokeCredential: (credentialId: string) => Promise<unknown>;
  }>,
) {
  const now = input.now ?? new Date();
  const due = await prisma.mobileAccessCredential.findMany({
    where: {
      status: { in: ["PENDING", "ACTIVE"] },
      recoveryNextAttemptAt: { lte: now },
      recoveryExhaustedAt: null,
    },
    select: { id: true },
    orderBy: { recoveryNextAttemptAt: "asc" },
    take: Math.min(Math.max(input.limit ?? 25, 1), 100),
  });

  const results: Array<{ credentialId: string; outcome: "REVOKED" | "RETRY_SCHEDULED" | "EXHAUSTED" }> = [];
  for (const credential of due) {
    try {
      await input.revokeCredential(credential.id);
      results.push({ credentialId: credential.id, outcome: "REVOKED" });
    } catch {
      const state = await prisma.mobileAccessCredential.findUnique({
        where: { id: credential.id },
        select: { recoveryExhaustedAt: true },
      });
      results.push({
        credentialId: credential.id,
        outcome: state?.recoveryExhaustedAt ? "EXHAUSTED" : "RETRY_SCHEDULED",
      });
    }
  }

  return { processed: results.length, results };
}
