import type { PrismaClient, Prisma } from "@prisma/client";
import type { RecoveryLease } from "./sales-voice-recovery-lease.service.js";
import {
  noteLiveUsage, finalizeLiveClosed, type SidebandObservation,
} from "./sales-voice-live-watchdog.service.js";

export type RecoveryObservationDB = Pick<PrismaClient, "$transaction">;
export class SalesVoiceRecoveryOwnershipLost extends Error {
  constructor() { super("RECOVERY_OWNERSHIP_LOST"); this.name = "SalesVoiceRecoveryOwnershipLost"; }
}
const held = ["ADMISSION_CLAIMED", "ACCEPTED", "ACCEPT_UNKNOWN",
  "HANGUP_CLAIMED", "HANGUP_SENT", "HANGUP_UNKNOWN"];

function validate(lease: RecoveryLease): void {
  if (!lease || !/^live_[A-Za-z0-9_-]{1,123}$/.test(lease.sessionId)
    || !/^voice_[A-Za-z0-9_-]{12,70}$/.test(lease.owner)
    || !Number.isSafeInteger(lease.epoch) || lease.epoch < 1
    || !(lease.expiresAt instanceof Date) || !Number.isFinite(lease.expiresAt.getTime())) {
    throw new Error("INVALID_RECOVERY_OBSERVATION_LEASE");
  }
}
async function clock(tx: Prisma.TransactionClient): Promise<Date> {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  if (!(row?.now instanceof Date) || !Number.isFinite(row.now.getTime())) {
    throw new Error("RECOVERY_DATABASE_CLOCK_REQUIRED");
  }
  return row.now;
}

/**
 * Dormant sideband storage fence. PostgreSQL row lock serializes lease takeover
 * against usage/finalization. Provider operations NEVER occur in this transaction.
 * Both entry and exit use database time: late/expired work is rolled back.
 */
async function fenced<T>(db: RecoveryObservationDB, lease: RecoveryLease,
  action: (tx: Prisma.TransactionClient, now: Date) => Promise<T>): Promise<T> {
  validate(lease);
  return db.$transaction(async tx => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "SalesVoiceCall"
      WHERE "providerCallId" = ${lease.sessionId} FOR UPDATE
    `;
    if (locked.length !== 1) throw new SalesVoiceRecoveryOwnershipLost();
    const now = await clock(tx); // read AFTER any lock wait
    const row = await tx.salesVoiceCall.findUniqueOrThrow({
      where: { providerCallId: lease.sessionId },
    });
    if (row.provider !== "OPENAI_LIVE_SIP" || row.direction !== "INBOUND"
      || row.finalizedAt || !held.includes(row.status)
      || row.recoveryLeaseOwner !== lease.owner || row.recoveryLeaseEpoch !== lease.epoch
      || !row.recoveryLeaseUntil || row.recoveryLeaseUntil.getTime() <= now.getTime()) {
      throw new SalesVoiceRecoveryOwnershipLost();
    }
    const result = await action(tx, now);
    const end = await clock(tx);
    // The row stays locked through commit; another owner cannot change it.
    // A lease that expired while DB work ran cannot commit any observation.
    if (row.recoveryLeaseUntil.getTime() <= end.getTime()) {
      throw new SalesVoiceRecoveryOwnershipLost();
    }
    return result;
  }, { maxWait: 2000, timeout: 5000 });
}

export async function verifySalesVoiceRecoveryOwnership(
  db: RecoveryObservationDB, lease: RecoveryLease,
): Promise<void> {
  await fenced(db, lease, async () => undefined);
}

/** Caller supplies ONLY an authenticated, session-bound sideband observation. */
export async function applyFencedSalesVoiceObservation(
  db: RecoveryObservationDB, lease: RecoveryLease, observation: SidebandObservation,
): Promise<void> {
  validate(lease);
  if (observation.sessionId !== lease.sessionId) throw new Error("RECOVERY_OBSERVATION_SESSION_MISMATCH");
  await fenced(db, lease, async (tx, now) => {
    if (observation.type === "usage") await noteLiveUsage(tx, observation, now);
    else await finalizeLiveClosed(tx, observation, now);
  });
}
