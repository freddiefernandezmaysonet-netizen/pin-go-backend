import type { PrismaClient } from "@prisma/client";
import {
  reconcileTwilioSmsDeliveryReceipt,
  type SmsRecoverySettings,
} from "./twilio-sms-delivery-receipt.service.js";

export type TwilioReceiptReconciliationSettings = {
  intervalMs: number;
  maxAgeMs: number;
  maxAttempts: number;
  batchSize: number;
};

const ACCOUNT = /^AC[0-9a-fA-F]{32}$/;
const unresolved = ["PENDING", "UNMATCHED", "MAPPING_CHANGED", "AMBIGUOUS"] as const;
const fail = (code: string): never => { throw new Error(`TWILIO_RECEIPT_RECONCILER_${code}`); };

function validSettings(s: TwilioReceiptReconciliationSettings) {
  if (!Number.isSafeInteger(s.intervalMs) || s.intervalMs < 60_000 || s.intervalMs > 3_600_000 ||
      !Number.isSafeInteger(s.maxAgeMs) || s.maxAgeMs < 3_600_000 || s.maxAgeMs > 7 * 24 * 3_600_000 ||
      !Number.isSafeInteger(s.maxAttempts) || s.maxAttempts < 1 || s.maxAttempts > 24 ||
      !Number.isSafeInteger(s.batchSize) || s.batchSize < 1 || s.batchSize > 100) fail("SETTINGS_INVALID");
}
function validDate(d: Date) {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/** Separate explicit gate from callback ingestion. No production cadence is implied. */
export function resolveTwilioReceiptReconciliationSettings(
  env: NodeJS.ProcessEnv
): TwilioReceiptReconciliationSettings | null {
  if (env.TWILIO_SMS_RECEIPT_RECONCILIATION_ENABLED !== "1") return null;
  const interval = env.TWILIO_SMS_RECEIPT_RECONCILE_INTERVAL_MINUTES ?? "";
  const maxAge = env.TWILIO_SMS_RECEIPT_RECONCILE_MAX_AGE_HOURS ?? "";
  const attempts = env.TWILIO_SMS_RECEIPT_RECONCILE_MAX_ATTEMPTS ?? "";
  const batch = env.TWILIO_SMS_RECEIPT_RECONCILE_BATCH_SIZE ?? "";
  if (![interval, maxAge, attempts, batch].every(v => /^\d+$/.test(v))) fail("SETTINGS_INVALID");
  const settings = {
    intervalMs: Number(interval) * 60_000,
    maxAgeMs: Number(maxAge) * 3_600_000,
    maxAttempts: Number(attempts),
    batchSize: Number(batch),
  };
  validSettings(settings);
  return settings;
}

type ClaimedReceipt = { id: string; reconcileAttempts: number };

/** Bounded inbox continuation. It performs no provider call and sends no SMS.
 * FOR UPDATE SKIP LOCKED makes concurrent consumers partition the due inbox.
 * The attempt is consumed before reconciliation; a crash cannot spin the same
 * receipt immediately and an unresolved receipt eventually becomes exhausted.
 */
export async function reconcilePendingTwilioSmsReceipts(
  db: PrismaClient,
  accountSid: string,
  recoverySettings: SmsRecoverySettings,
  settings: TwilioReceiptReconciliationSettings,
  clock: () => Date = () => new Date()
) {
  if (!ACCOUNT.test(accountSid)) fail("ACCOUNT_INVALID");
  validSettings(settings);
  const now = clock();
  if (!validDate(now)) fail("CLOCK_INVALID");
  const cutoff = new Date(now.getTime() - settings.maxAgeMs);
  const next = new Date(now.getTime() + settings.intervalMs);
  const states = [...unresolved];

  const expired = await db.$executeRawUnsafe(
    `UPDATE "TwilioSmsDeliveryReceipt"
       SET "disposition"='RECONCILIATION_EXHAUSTED',"processedAt"=$3
       WHERE "accountSid"=$1
         AND "disposition" = ANY($2::text[])
         AND ("reconcileAttempts" >= $4 OR "receivedAt" < $5)`,
    accountSid, states, now, settings.maxAttempts, cutoff
  );

  const claimed = await db.$transaction(async tx => {
    const rows = await tx.$queryRawUnsafe<ClaimedReceipt[]>(
      `SELECT "id","reconcileAttempts" FROM "TwilioSmsDeliveryReceipt"
       WHERE "accountSid"=$1
         AND "disposition" = ANY($2::text[])
         AND "reconcileAttempts" < $3
         AND "receivedAt" >= $4
         AND ("nextReconcileAt" IS NULL OR "nextReconcileAt" <= $5)
       ORDER BY "receivedAt" ASC, "id" ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $6`,
      accountSid, states, settings.maxAttempts, cutoff, now, settings.batchSize
    );
    for (const row of rows) {
      await tx.$executeRawUnsafe(
        `UPDATE "TwilioSmsDeliveryReceipt"
         SET "reconcileAttempts"="reconcileAttempts"+1,
             "lastReconciledAt"=$2,"nextReconcileAt"=$3
         WHERE "id"=$1`,
        row.id, now, next
      );
    }
    return rows.map(row => ({ ...row, reconcileAttempts: row.reconcileAttempts + 1 }));
  }, { maxWait: 20_000, timeout: 20_000 });

  let applied = 0;
  let unresolvedCount = 0;
  let failed = 0;
  let exhaustedAfterAttempt = 0;

  for (const row of claimed) {
    try {
      const result = await reconcileTwilioSmsDeliveryReceipt(
        db, row.id, accountSid, recoverySettings, clock
      );
      const stillUnresolved = (unresolved as readonly string[]).includes(result.disposition);
      if (stillUnresolved) {
        unresolvedCount += 1;
        if (row.reconcileAttempts >= settings.maxAttempts) {
          const changed = await db.$executeRawUnsafe(
            `UPDATE "TwilioSmsDeliveryReceipt"
             SET "disposition"='RECONCILIATION_EXHAUSTED',"processedAt"=$2
             WHERE "id"=$1 AND "disposition" = ANY($3::text[])`,
            row.id, clock(), states
          );
          exhaustedAfterAttempt += changed;
        }
      } else {
        applied += 1;
      }
    } catch {
      failed += 1;
      if (row.reconcileAttempts >= settings.maxAttempts) {
        const at = clock();
        if (!validDate(at)) fail("CLOCK_INVALID");
        const changed = await db.$executeRawUnsafe(
          `UPDATE "TwilioSmsDeliveryReceipt"
           SET "disposition"='RECONCILIATION_EXHAUSTED',"processedAt"=$2
           WHERE "id"=$1 AND "disposition" = ANY($3::text[])`,
          row.id, at, states
        );
        exhaustedAfterAttempt += changed;
      }
    }
  }

  return {
    claimed: claimed.length,
    applied,
    unresolved: unresolvedCount,
    failed,
    exhausted: expired + exhaustedAfterAttempt,
  };
}
