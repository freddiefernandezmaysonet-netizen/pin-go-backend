import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  persistTwilioSmsDeliveryReceipt,
} from "./twilio-sms-delivery-receipt.service.js";
import {
  claimTwilioSmsRecovery,
  recordTwilioSmsRetrySubmission,
  registerTwilioSmsRecovery,
  type SmsRecoveryDatabase,
  type SmsRecoveryScope,
} from "./twilio-sms-recovery.store.js";
import {
  reconcilePendingTwilioSmsReceipts,
  resolveTwilioReceiptReconciliationSettings,
} from "./twilio-sms-receipt-reconciler.service.js";

const expected = "postgresql://ci:ci@127.0.0.1:5432/pin_go_twilio_sms_recovery";
if (process.env.DATABASE_URL !== expected || process.env.TWILIO_RECOVERY_DISPOSABLE_DB !== "1") {
  throw new Error("DISPOSABLE_TWILIO_RECONCILIATION_DATABASE_REQUIRED");
}
const db = new PrismaClient();
const store: SmsRecoveryDatabase = { $transaction: work => db.$transaction(tx => work(tx)) };
const ACCOUNT = "AC" + "c".repeat(32);
const first = new Date("2026-10-02T16:00:04.000Z");
const due = new Date("2026-10-02T16:30:04.000Z");
const retryAt = new Date("2026-10-02T16:31:04.000Z");
const arrival = new Date("2026-10-02T20:00:00.000Z");
const departure = new Date("2026-10-04T15:00:00.000Z");
const recoverySettings = { delayMs: 1_800_000, minimumSpacingMs: 900_000 };
const reconcileSettings = { intervalMs: 60_000, maxAgeMs: 24 * 3_600_000, maxAttempts: 3, batchSize: 20 };
const sid = () => "SM" + randomBytes(16).toString("hex");
const providerEvent = (providerMessageId: string, status: "DELIVERED" | "UNDELIVERED", at: Date) => ({
  provider: "twilio" as const,
  providerMessageId,
  status,
  errorCode: status === "UNDELIVERED" ? "30005" : null,
  errorMessage: null,
  eventAt: at,
  deliveredAt: status === "DELIVERED" ? at : null,
});

async function fixture() {
  const org = await db.organization.create({ data: { name: "Receipt reconcile " + randomUUID() } });
  const property = await db.property.create({ data: { organizationId: org.id, name: "Offline property" } });
  const reservation = await db.reservation.create({ data: {
    propertyId: property.id, guestName: "Offline guest", guestPhone: "+17875550101",
    checkIn: arrival, checkOut: departure,
  } });
  const originalSid = sid();
  const message = await db.messageLog.create({ data: {
    organizationId: org.id, propertyId: property.id, reservationId: reservation.id,
    channel: "sms", provider: "twilio", to: "+17875550101", body: "Offline precheckin",
    communicationType: "PRECHECKIN", providerMessageId: originalSid, status: "SENT",
    providerDeliveryStatus: "UNDELIVERED", providerErrorCode: "30005",
    providerStatusUpdatedAt: first, createdAt: first,
  } });
  const scope: SmsRecoveryScope = {
    messageLogId: message.id, organizationId: org.id, propertyId: property.id,
    reservationId: reservation.id, originalProviderMessageId: originalSid,
  };
  await registerTwilioSmsRecovery(store, scope, recoverySettings, () => first);
  const claim = await claimTwilioSmsRecovery(store, scope,
    async () => ({ eligible: true, contentValidUntil: arrival, nextScheduledMessage: null }),
    () => due);
  assert.equal(claim.kind, "CLAIMED");
  if (claim.kind !== "CLAIMED") throw new Error("EXPECTED_CLAIM");
  return { org, property, reservation, message, scope, claim };
}
async function receiptBySid(providerMessageId: string) {
  const [row] = await db.$queryRawUnsafe<Array<{
    id: string; disposition: string; reconcileAttempts: number;
    lastReconciledAt: Date | null; nextReconcileAt: Date | null;
  }>>('SELECT * FROM "TwilioSmsDeliveryReceipt" WHERE "providerMessageId"=$1 ORDER BY "receivedAt" DESC LIMIT 1',
    providerMessageId);
  return row!;
}

test("bounded receipt reconciliation and retry-SID outcomes", async t => {
  t.after(() => db.$disconnect());

  await t.test("delivered retry SID closes journal without rewriting original attempt", async () => {
    const f = await fixture(), retrySid = sid();
    await recordTwilioSmsRetrySubmission(store, f.scope, f.claim.claimToken, retrySid, () => due);
    const original = await db.messageLog.findUniqueOrThrow({ where: { id: f.message.id } });
    const result = await persistTwilioSmsDeliveryReceipt(
      db, ACCOUNT, providerEvent(retrySid, "DELIVERED", retryAt), recoverySettings, () => retryAt
    );
    assert.equal(result.disposition, "RETRY_APPLIED");
    const journal = await db.twilioSmsRecovery.findUniqueOrThrow({ where: { messageLogId: f.message.id } });
    assert.equal(journal.state, "DELIVERED");
    assert.equal(journal.retryProviderMessageId, retrySid);
    assert.equal(journal.retryDeliveryStatus, "DELIVERED");
    assert.equal(journal.retryErrorCode, null);
    assert.equal(journal.retryDeliveredAt?.getTime(), retryAt.getTime());
    assert.deepEqual(await db.messageLog.findUnique({ where: { id: f.message.id } }), original);
  });

  await t.test("failed retry SID exhausts automatic replay and preserves original failure", async () => {
    const f = await fixture(), retrySid = sid();
    await recordTwilioSmsRetrySubmission(store, f.scope, f.claim.claimToken, retrySid, () => due);
    const original = await db.messageLog.findUniqueOrThrow({ where: { id: f.message.id } });
    const result = await persistTwilioSmsDeliveryReceipt(
      db, ACCOUNT, providerEvent(retrySid, "UNDELIVERED", retryAt), recoverySettings, () => retryAt
    );
    assert.equal(result.disposition, "RETRY_APPLIED");
    const journal = await db.twilioSmsRecovery.findUniqueOrThrow({ where: { messageLogId: f.message.id } });
    assert.equal(journal.state, "REVIEW");
    assert.equal(journal.retriesUsed, 1);
    assert.equal(journal.retryDeliveryStatus, "UNDELIVERED");
    assert.equal(journal.retryErrorCode, "30005");
    assert.deepEqual(await db.messageLog.findUnique({ where: { id: f.message.id } }), original);
  });

  await t.test("receipt can arrive before retry SID is journaled and later reconcile exactly once", async () => {
    const f = await fixture(), retrySid = sid();
    const early = await persistTwilioSmsDeliveryReceipt(
      db, ACCOUNT, providerEvent(retrySid, "DELIVERED", retryAt), recoverySettings, () => retryAt
    );
    assert.equal(early.disposition, "UNMATCHED");
    await recordTwilioSmsRetrySubmission(store, f.scope, f.claim.claimToken, retrySid, () => due);
    const result = await reconcilePendingTwilioSmsReceipts(
      db, ACCOUNT, recoverySettings, reconcileSettings, () => new Date(retryAt.getTime() + 60_000)
    );
    assert.equal(result.claimed, 1);
    assert.equal(result.applied, 1);
    const row = await receiptBySid(retrySid);
    assert.equal(row.disposition, "RETRY_APPLIED");
    assert.equal(row.reconcileAttempts, 1);
    assert.equal((await db.twilioSmsRecovery.findUniqueOrThrow({ where: { messageLogId: f.message.id } })).state,
      "DELIVERED");
  });

  await t.test("concurrent inbox consumers partition due unmatched receipts", async () => {
    const sids = Array.from({ length: 8 }, () => sid());
    for (const providerMessageId of sids) {
      await persistTwilioSmsDeliveryReceipt(
        db, ACCOUNT, providerEvent(providerMessageId, "UNDELIVERED", retryAt),
        recoverySettings, () => retryAt
      );
    }
    const now = new Date(retryAt.getTime() + 60_000);
    const [a, b] = await Promise.all([
      reconcilePendingTwilioSmsReceipts(db, ACCOUNT, recoverySettings, reconcileSettings, () => now),
      reconcilePendingTwilioSmsReceipts(db, ACCOUNT, recoverySettings, reconcileSettings, () => now),
    ]);
    assert.equal(a.claimed + b.claimed, 8);
    for (const providerMessageId of sids) {
      const row = await receiptBySid(providerMessageId);
      assert.equal(row.reconcileAttempts, 1);
      assert.equal(row.disposition, "UNMATCHED");
      assert.equal(row.lastReconciledAt?.getTime(), now.getTime());
    }
  });

  await t.test("last permitted unresolved attempt becomes terminally exhausted", async () => {
    const providerMessageId = sid();
    await persistTwilioSmsDeliveryReceipt(
      db, ACCOUNT, providerEvent(providerMessageId, "UNDELIVERED", retryAt),
      recoverySettings, () => retryAt
    );
    const row = await receiptBySid(providerMessageId);
    await db.$executeRawUnsafe(
      'UPDATE "TwilioSmsDeliveryReceipt" SET "reconcileAttempts"=$2,"nextReconcileAt"=NULL WHERE "id"=$1',
      row.id, reconcileSettings.maxAttempts - 1
    );
    const now = new Date(retryAt.getTime() + 60_000);
    const result = await reconcilePendingTwilioSmsReceipts(
      db, ACCOUNT, recoverySettings, reconcileSettings, () => now
    );
    assert.equal(result.claimed, 1);
    assert.equal(result.exhausted, 1);
    const final = await receiptBySid(providerMessageId);
    assert.equal(final.reconcileAttempts, reconcileSettings.maxAttempts);
    assert.equal(final.disposition, "RECONCILIATION_EXHAUSTED");
  });

  await t.test("stale unmatched evidence expires without another processing attempt", async () => {
    const providerMessageId = sid();
    const old = new Date(retryAt.getTime() - reconcileSettings.maxAgeMs - 1);
    await persistTwilioSmsDeliveryReceipt(
      db, ACCOUNT, providerEvent(providerMessageId, "UNDELIVERED", old),
      recoverySettings, () => retryAt
    );
    const before = await receiptBySid(providerMessageId);
    const result = await reconcilePendingTwilioSmsReceipts(
      db, ACCOUNT, recoverySettings, reconcileSettings, () => retryAt
    );
    assert.ok(result.exhausted >= 1);
    const after = await receiptBySid(providerMessageId);
    assert.equal(after.reconcileAttempts, before.reconcileAttempts);
    assert.equal(after.disposition, "RECONCILIATION_EXHAUSTED");
  });

  await t.test("reconciliation configuration is explicit and bounded", () => {
    assert.equal(resolveTwilioReceiptReconciliationSettings({}), null);
    assert.throws(() => resolveTwilioReceiptReconciliationSettings({
      TWILIO_SMS_RECEIPT_RECONCILIATION_ENABLED: "1",
    }), /SETTINGS_INVALID/);
    assert.deepEqual(resolveTwilioReceiptReconciliationSettings({
      TWILIO_SMS_RECEIPT_RECONCILIATION_ENABLED: "1",
      TWILIO_SMS_RECEIPT_RECONCILE_INTERVAL_MINUTES: "1",
      TWILIO_SMS_RECEIPT_RECONCILE_MAX_AGE_HOURS: "24",
      TWILIO_SMS_RECEIPT_RECONCILE_MAX_ATTEMPTS: "3",
      TWILIO_SMS_RECEIPT_RECONCILE_BATCH_SIZE: "20",
    }), reconcileSettings);
  });
});
