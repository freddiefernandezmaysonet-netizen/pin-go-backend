import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { persistTwilioSmsAccessGap } from "./twilio-sms-access-gap.service.js";
import {
  recordMessageDeliveryOutcome,
  shouldApplyProviderDeliveryTransition,
  type ProviderDeliveryOutcome,
} from "./guest-journey-communications-delivery-outcome.service.js";
import {
  recordTwilioSmsRetryDeliveryOutcome,
  registerTwilioSmsRecovery,
  type SmsRecoverySettings,
} from "./twilio-sms-recovery.store.js";

type Tx = Prisma.TransactionClient;
type Receipt = {
  id: string; accountSid: string; providerMessageId: string; deliveryStatus: string;
  errorCode: string | null; receivedAt: Date; disposition: string; messageLogId: string | null;
};
type ReservationScope = {
  id: string; propertyId: string; organizationId: string; propertyStatus: string;
  status: string; cancelledAt: Date | null; checkIn: Date; checkOut: Date;
  guestPhone: string | null; guestEmail: string | null;
};
const SID = /^SM[0-9a-fA-F]{32}$/;
const ACCOUNT = /^AC[0-9a-fA-F]{32}$/;
const statuses = new Set(["ACCEPTED", "QUEUED", "SENDING", "SENT", "DELIVERED", "READ", "UNDELIVERED", "FAILED", "CANCELED"]);
const successful = (s: string | null) => s === "DELIVERED" || s === "READ";
const failed = (s: string | null) => s === "UNDELIVERED" || s === "FAILED" || s === "CANCELED";
const validDate = (d: Date) => d instanceof Date && Number.isFinite(d.getTime());
const problem = (code: string): never => { throw new Error(`TWILIO_RECEIPT_${code}`); };

/** Explicit opt-in and explicit timings; no live default is selected here. */
export function resolveTwilioSmsRecoverySettings(env: NodeJS.ProcessEnv): SmsRecoverySettings | null {
  if (env.TWILIO_SMS_RECOVERY_ENABLED !== "1") return null;
  const delay = env.TWILIO_SMS_RETRY_DELAY_MINUTES ?? "";
  const spacing = env.TWILIO_SMS_MINIMUM_SPACING_MINUTES ?? "";
  if (!/^\d+$/.test(delay) || !/^\d+$/.test(spacing)) return problem("SETTINGS_INVALID");
  const settings = { delayMs: Number(delay) * 60_000, minimumSpacingMs: Number(spacing) * 60_000 };
  validateSettings(settings);
  return settings;
}
function validateSettings(s: SmsRecoverySettings) {
  if (!Number.isSafeInteger(s.delayMs) || s.delayMs < 60_000 || s.delayMs > 86_400_000 ||
      !Number.isSafeInteger(s.minimumSpacingMs) || s.minimumSpacingMs < 60_000 || s.minimumSpacingMs > 3_600_000) {
    problem("SETTINGS_INVALID");
  }
}
async function transaction<T>(db: PrismaClient, work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(work, { maxWait: 20_000, timeout: 20_000 }); }
    catch (error) {
      const e = error as { code?: string; meta?: { code?: string } };
      if (attempt >= 2 || !(e?.code === "P2034" || ["40001", "40P01"].includes(e?.meta?.code ?? ""))) throw error;
    }
  }
}
async function finish(tx: Tx, receiptId: string, disposition: string, messageLogId: string | null, at: Date) {
  await tx.$executeRawUnsafe(`UPDATE "TwilioSmsDeliveryReceipt" SET "disposition"=$2,
    "messageLogId"=$3, "processedAt"=$4 WHERE "id"=$1`, receiptId, disposition, messageLogId, at);
  return { receiptId, disposition, messageLogId };
}

/** Only call after SDK signature AND configured AccountSid validation. This first
 * transaction retains evidence even if the later projection transaction fails.
 * No raw payload, free-form provider error, destination or access secret is copied.
 */
export async function persistTwilioSmsDeliveryReceipt(
  db: PrismaClient, accountSid: string, outcome: ProviderDeliveryOutcome,
  settings: SmsRecoverySettings, clock: () => Date = () => new Date()
) {
  validateSettings(settings);
  const now = clock();
  const errorCode = outcome.errorCode?.trim() || null;
  if (!ACCOUNT.test(accountSid) || outcome.provider !== "twilio" || !SID.test(outcome.providerMessageId) ||
      !statuses.has(outcome.status) || !validDate(now) || !validDate(outcome.eventAt) || outcome.eventAt > now ||
      (errorCode !== null && !/^\d{1,10}$/.test(errorCode))) return problem("INPUT_INVALID");
  const receiptId = createHash("sha256").update(JSON.stringify([
    accountSid, outcome.providerMessageId, outcome.status, errorCode,
  ])).digest("hex");
  await db.$executeRawUnsafe(`INSERT INTO "TwilioSmsDeliveryReceipt"
    ("id","accountSid","providerMessageId","deliveryStatus","errorCode","receivedAt")
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT ("id") DO NOTHING`,
    receiptId, accountSid, outcome.providerMessageId, outcome.status, errorCode, outcome.eventAt);
  return reconcileTwilioSmsDeliveryReceipt(db, receiptId, accountSid, settings, clock);
}

/** Exact-receipt replay. Used by authenticated ingress and future bounded inbox
 * reconciliation. Unknown/early receipts are retained, not falsely acknowledged
 * as mapped. This function does not fetch Twilio or send any communication.
 */
export async function reconcileTwilioSmsDeliveryReceipt(
  db: PrismaClient, receiptId: string, accountSid: string, settings: SmsRecoverySettings,
  clock: () => Date = () => new Date()
) {
  validateSettings(settings);
  if (!/^[0-9a-f]{64}$/.test(receiptId) || !ACCOUNT.test(accountSid)) return problem("IDENTITY_INVALID");
  return transaction(db, async tx => {
    const [receipt] = await tx.$queryRawUnsafe<Receipt[]>(
      'SELECT * FROM "TwilioSmsDeliveryReceipt" WHERE "id"=$1 AND "accountSid"=$2', receiptId, accountSid);
    if (!receipt) return problem("NOT_FOUND");
    if (!SID.test(receipt.providerMessageId) || !statuses.has(receipt.deliveryStatus) ||
        !validDate(receipt.receivedAt) || (receipt.errorCode !== null && !/^\d{1,10}$/.test(receipt.errorCode))) {
      return problem("STORED_EVIDENCE_INVALID");
    }
    let now = clock();
    if (!validDate(now)) return problem("CLOCK_INVALID");
    // Serialize each SID, then follow the existing recovery journal -> source lock order.
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      `sms-delivery:${accountSid}:${receipt.providerMessageId}`);
    const mappings = await tx.messageLog.findMany({
      where: { provider: "twilio", providerMessageId: receipt.providerMessageId }, take: 2,
    });
    if (mappings.length === 0) {
      const retry = await recordTwilioSmsRetryDeliveryOutcome(
        { $transaction: async work => work(tx) },
        {
          providerMessageId: receipt.providerMessageId,
          status: receipt.deliveryStatus as ProviderDeliveryOutcome["status"],
          errorCode: receipt.errorCode,
          eventAt: receipt.receivedAt,
        },
        () => now
      );
      if (retry.matched) {
        return finish(
          tx,
          receiptId,
          `RETRY_${retry.disposition}`,
          retry.messageLogId,
          now
        );
      }
      return finish(tx, receiptId, "UNMATCHED", null, now);
    }
    if (mappings.length !== 1) {
      return finish(tx, receiptId, "AMBIGUOUS", null, now);
    }
    const mapped = mappings[0]!;
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", `sms-recovery:${mapped.id}`);
    await tx.$queryRawUnsafe('SELECT "id" FROM "MessageLog" WHERE "id"=$1 FOR UPDATE', mapped.id);
    const currentMappings = await tx.messageLog.findMany({
      where: { provider: "twilio", providerMessageId: receipt.providerMessageId }, take: 2,
    });
    if (currentMappings.length !== 1 || currentMappings[0]?.id !== mapped.id) {
      return finish(tx, receiptId, "MAPPING_CHANGED", null, now);
    }
    const message = currentMappings[0]!;
    if (message.channel !== "sms") return finish(tx, receiptId, "OUT_OF_SCOPE", message.id, now);
    // Contradictory terminal evidence is retained for review, never silently flipped.
    const previous = message.providerDeliveryStatus;
    if ((successful(previous) && failed(receipt.deliveryStatus)) ||
        (failed(previous) && successful(receipt.deliveryStatus)) ||
        (receipt.errorCode !== null && !failed(receipt.deliveryStatus))) {
      await tx.$executeRawUnsafe(`UPDATE "TwilioSmsRecovery" SET "state"='REVIEW',
        "lastDecision"='CONTRADICTORY_PROVIDER_EVIDENCE',"updatedAt"=$2
        WHERE "messageLogId"=$1 AND "state"='AVAILABLE'`, message.id, now);
      return finish(tx, receiptId, "CONFLICT", message.id, now);
    }
    if (!shouldApplyProviderDeliveryTransition(previous, receipt.deliveryStatus as ProviderDeliveryOutcome["status"])) {
      return finish(tx, receiptId, "IGNORED_OLDER_STATE", message.id, now);
    }
    // Duplicate callbacks without ErrorCode cannot erase 30005 or postpone its anchor.
    const sameFailure = failed(previous) && failed(receipt.deliveryStatus);
    const mergedCode = sameFailure && !receipt.errorCode ? message.providerErrorCode : receipt.errorCode;
    const eventAt = sameFailure && message.providerStatusUpdatedAt
      ? new Date(Math.min(message.providerStatusUpdatedAt.getTime(), receipt.receivedAt.getTime()))
      : receipt.receivedAt;
    const normalized: ProviderDeliveryOutcome = {
      provider: "twilio", providerMessageId: receipt.providerMessageId,
      status: receipt.deliveryStatus as ProviderDeliveryOutcome["status"], eventAt,
      errorCode: mergedCode,
      errorMessage: mergedCode ? `Twilio delivery error ${mergedCode}` : null,
      deliveredAt: successful(receipt.deliveryStatus) ? receipt.receivedAt : null,
    };
    const applied = await recordMessageDeliveryOutcome(tx, normalized);
    if (!applied.matched || applied.messageLogId !== message.id) return problem("MAPPING_CHANGED");
    if (mergedCode !== "30005" || !["UNDELIVERED", "FAILED"].includes(receipt.deliveryStatus) ||
        !["PRECHECKIN", "GUEST_ACCESS_PASSCODE"].includes(message.communicationType ?? "")) {
      return finish(tx, receiptId, "APPLIED", message.id, now);
    }
    const [reservation] = await tx.$queryRawUnsafe<ReservationScope[]>(`
      SELECT r."id",r."propertyId",r."status",r."cancelledAt",r."checkIn",r."checkOut",
        r."guestPhone",r."guestEmail",p."organizationId",p."status" AS "propertyStatus"
      FROM "Reservation" r JOIN "Property" p ON p."id"=r."propertyId"
      WHERE r."id"=$1 AND r."propertyId"=$2 AND p."organizationId"=$3 FOR UPDATE OF r,p`,
      message.reservationId, message.propertyId, message.organizationId);
    now = clock(); // Scope locks may have waited across an arrival/checkout boundary.
    if (!validDate(now)) return problem("CLOCK_INVALID");
    if (!reservation || reservation.status !== "ACTIVE" || reservation.cancelledAt !== null ||
        reservation.propertyStatus !== "ACTIVE" || reservation.checkOut <= reservation.checkIn ||
        now >= reservation.checkOut) return finish(tx, receiptId, "APPLIED_NOT_CURRENT", message.id, now);
    const recipientCurrent = Boolean(reservation.guestPhone?.trim()) && message.to.trim() === reservation.guestPhone?.trim();
    if (!recipientCurrent) return finish(tx, receiptId, "APPLIED_RECIPIENT_CHANGED", message.id, now);
    const scope = { messageLogId: message.id, organizationId: reservation.organizationId,
      propertyId: reservation.propertyId, reservationId: reservation.id, originalProviderMessageId: receipt.providerMessageId };
    // Register without calling an external provider; nested work shares this transaction.
    if (message.retryCount === 0 && (message.communicationType !== "PRECHECKIN" || now < reservation.checkIn)) {
      await registerTwilioSmsRecovery({ $transaction: async work => work(tx) }, scope, settings, () => now);
    }
    // Reuse the audited projector; it revalidates active grant/lock evidence and
    // keeps its host action independent from the retry owner in this transaction.
    await persistTwilioSmsAccessGap(tx, scope, () => now);
    return finish(tx, receiptId, "APPLIED", message.id, now);
  });
}
