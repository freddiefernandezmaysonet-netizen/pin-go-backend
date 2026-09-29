import { prisma } from "../lib/prisma.js";
import { runDueMobileAccessRecovery } from "../guest-mobile/mobile-access-recovery.service.js";
import { findMobileAccessRevocationsDue } from "../guest-mobile/mobile-access-revocation-observer.service.js";

const intervalMs = Math.max(Number(process.env.MOBILE_ACCESS_RECOVERY_TICK_MS ?? 60_000), 60_000);

export async function runMobileAccessRecoveryTick(
  revokeCredential: (credentialId: string) => Promise<unknown>,
) {
  const observed = await findMobileAccessRevocationsDue(prisma, new Date(), 25);
  const observedResults: Array<{ credentialId: string; outcome: "REVOKED" | "RECOVERY_SCHEDULED" }> = [];

  for (const credential of observed) {
    if (credential.recoveryNextAttemptAt) continue;
    try {
      await revokeCredential(credential.id);
      observedResults.push({ credentialId: credential.id, outcome: "REVOKED" });
    } catch {
      observedResults.push({ credentialId: credential.id, outcome: "RECOVERY_SCHEDULED" });
    }
  }

  const recovery = await runDueMobileAccessRecovery(prisma, {
    limit: 25,
    revokeCredential,
  });

  return {
    observed: observedResults.length,
    observedResults,
    recovery,
  };
}

export async function startMobileAccessRecoveryWorker(
  revokeCredential: (credentialId: string) => Promise<unknown>,
) {
  for (;;) {
    try {
      const result = await runMobileAccessRecoveryTick(revokeCredential);
      if (result.observed > 0 || result.recovery.processed > 0) {
        console.log("[MOBILE_ACCESS_RECOVERY]", {
          observed: result.observed,
          recoveryProcessed: result.recovery.processed,
          observedOutcomes: result.observedResults.map(item => item.outcome),
          recoveryOutcomes: result.recovery.results.map(item => item.outcome),
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
