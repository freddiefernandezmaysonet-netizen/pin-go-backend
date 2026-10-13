import type { PrismaClient } from "@prisma/client";
import { inventoryUnresolvedSalesVoiceCalls } from "./sales-voice-recovery-classifier.service.js";
import { SalesVoiceRecoveryLease, SALES_VOICE_MAX_RECOVERY_EPOCHS, type RecoveryLease } from "./sales-voice-recovery-lease.service.js";
import { decideSalesVoiceRecovery, type RecoveryDecision } from "./sales-voice-reconciliation-decisions.service.js";

type DB = Pick<PrismaClient, "salesVoiceCall">;
type Env = Readonly<Record<string, string | undefined>>;
export type OwnedRecovery = Readonly<{ lease: RecoveryLease; decision: RecoveryDecision }>;

/**
 * Isolated certification cycle, NOT mounted in the API or any worker.
 * Coordinates persisted inventory + lease renewal/claim + no-evidence policy.
 * No transport, accept, hangup, attach, finalization or capacity release.
 * A future runtime must use an authoritative clock and fence every side effect;
 * the supplied fixture clock is permitted ONLY in this simulation environment.
 */
export async function runSimulatedSalesVoiceRecoveryCycle(input: {
  db: DB;
  env: Env;
  owner: string;
  now: Date;
  ttlSeconds: number;
  staleAfterSeconds: number;
  maxOwned: number;
  held: readonly RecoveryLease[];
}): Promise<{
  owned: OwnedRecovery[];
  lost: string[];
  exhausted: string[];
  quarantined: number;
  hasMore: boolean;
}> {
  if (input.env.NODE_ENV !== "test"
    || input.env.RAILWAY_ENVIRONMENT_NAME !== "sales-voice-certification"
    || input.env.SALES_VOICE_RECOVERY_CYCLE_SIMULATION_ENABLED !== "true"
    || input.env.SALES_VOICE_RECOVERY_CYCLE_RELEASE_CERTIFIED !== "true") {
    throw new Error("RECOVERY_CYCLE_PRODUCTION_VETO");
  }
  const { owner, now, ttlSeconds, staleAfterSeconds, maxOwned, held } = input;
  if (!/^voice_[A-Za-z0-9_-]{12,70}$/.test(owner)
    || !(now instanceof Date) || !Number.isFinite(now.getTime())
    || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 10 || ttlSeconds > 120
    || !Number.isSafeInteger(staleAfterSeconds) || staleAfterSeconds < 60 || staleAfterSeconds > 86400
    || !Number.isSafeInteger(maxOwned) || maxOwned < 1 || maxOwned > 25
    || !Array.isArray(held) || held.length > maxOwned) {
    throw new Error("INVALID_RECOVERY_CYCLE_BOUNDS");
  }
  const seen = new Set<string>();
  // Validate the whole batch before any database read or mutation.
  for (const lease of held) {
    if (!lease || lease.owner !== owner
      || !/^live_[A-Za-z0-9_-]{1,123}$/.test(lease.sessionId)
      || !Number.isSafeInteger(lease.epoch) || lease.epoch < 1
      || !(lease.expiresAt instanceof Date) || !Number.isFinite(lease.expiresAt.getTime())
      || seen.has(lease.sessionId)) throw new Error("INVALID_HELD_RECOVERY_LEASE");
    seen.add(lease.sessionId);
  }

  const leases = new SalesVoiceRecoveryLease(input.db);
  const owned: OwnedRecovery[] = [];
  const lost: string[] = [];
  const exhausted: string[] = [];
  const remember = async (lease: RecoveryLease): Promise<void> => {
    const row = await input.db.salesVoiceCall.findUnique({
      where: { providerCallId: lease.sessionId },
      select: {
        provider: true, direction: true, status: true, finalizedAt: true,
        recoveryLeaseOwner: true, recoveryLeaseEpoch: true, recoveryLeaseUntil: true,
      },
    });
    if (!row || row.finalizedAt || row.recoveryLeaseOwner !== owner
      || row.recoveryLeaseEpoch !== lease.epoch
      || !row.recoveryLeaseUntil || row.recoveryLeaseUntil.getTime() <= now.getTime()) {
      lost.push(lease.sessionId); return;
    }
    const decision = decideSalesVoiceRecovery({
      sessionId: lease.sessionId, provider: row.provider, direction: row.direction,
      status: row.status, finalized: false, evidence: { kind: "NONE" },
    });
    if (decision === "NO_ACTION") { lost.push(lease.sessionId); return; }
    owned.push({ lease, decision });
  };
  // Renewal precedes discovery. An expired/stolen/finalized lease is reported
  // lost, never released or immediately reclaimed by the same cycle.
  for (const lease of held) {
    const renewed = await leases.renew(lease, now, ttlSeconds);
    if (renewed) await remember(renewed);
    else lost.push(lease.sessionId);
  }
  if (owned.length === maxOwned) {
    return { owned, lost, exhausted, quarantined: 0, hasMore: true };
  }

  const inventory = await inventoryUnresolvedSalesVoiceCalls({
    db: input.db, now, staleAfterSeconds, limit: maxOwned,
  });
  let quarantined = 0;
  let deferred = inventory.hasMore;
  for (const candidate of inventory.candidates) {
    if (!candidate.sessionId) { quarantined++; continue; }
    if (seen.has(candidate.sessionId)) continue;
    if (owned.length >= maxOwned) { deferred = true; break; }
    const lease = await leases.claim({
      sessionId: candidate.sessionId, owner, now, ttlSeconds,
    });
    if (lease) await remember(lease);
    else {
      const row = await input.db.salesVoiceCall.findUnique({
        where: { providerCallId: candidate.sessionId },
        select: { recoveryLeaseEpoch: true },
      });
      if (row && row.recoveryLeaseEpoch >= SALES_VOICE_MAX_RECOVERY_EPOCHS) {
        exhausted.push(candidate.sessionId);
      }
    }
  }
  return { owned, lost, exhausted, quarantined, hasMore: deferred };
}
