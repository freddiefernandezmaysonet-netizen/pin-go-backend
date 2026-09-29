import { prisma } from "../lib/prisma.js";
import { runDueMobileAccessRecovery } from "../guest-mobile/mobile-access-recovery.service.js";

const intervalMs = Math.max(Number(process.env.MOBILE_ACCESS_RECOVERY_TICK_MS ?? 60_000), 60_000);

export async function runMobileAccessRecoveryTick(
  revokeCredential: (credentialId: string) => Promise<unknown>,
) {
  return runDueMobileAccessRecovery(prisma, {
    limit: 25,
    revokeCredential,
  });
}

export async function startMobileAccessRecoveryWorker(
  revokeCredential: (credentialId: string) => Promise<unknown>,
) {
  for (;;) {
    try {
      const result = await runMobileAccessRecoveryTick(revokeCredential);
      if (result.processed > 0) {
        console.log("[MOBILE_ACCESS_RECOVERY]", {
          processed: result.processed,
          outcomes: result.results.map(item => item.outcome),
        });
      }
    } catch (error) {
      console.error("[MOBILE_ACCESS_RECOVERY] tick failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
