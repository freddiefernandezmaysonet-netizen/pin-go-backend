import type { PrismaClient } from "@prisma/client";
import { sendSms } from "../integrations/twilio/twilio.client.js";
import { decryptAccessCode, hashAccessCode } from "./access-code-crypto.service.js";
import { isGuestOperationalSmsEligible } from "./guest-journey-access-communications-bridge.policy.js";
import { resolveGuestLanguage } from "./guest-language.service.js";
import { buildGuestPasscodeSmsBody } from "./messaging.service.js";
import {
  claimTwilioSmsRecovery,
  recordTwilioSmsRetrySubmission,
  type SmsRecoveryDatabase,
  type SmsRecoveryScope,
} from "./twilio-sms-recovery.store.js";

type Due = {
  messageLogId: string; organizationId: string; propertyId: string;
  reservationId: string; originalProviderMessageId: string;
};
const fail = (code: string): never => { throw new Error(`SMS_ACCESS_RETRY_${code}`); };

export type AccessSmsRetryDispatcherSettings = { batchSize: number };
export function resolveAccessSmsRetryDispatcherSettings(
  env: NodeJS.ProcessEnv
): AccessSmsRetryDispatcherSettings | null {
  if (env.TWILIO_SMS_ACCESS_RETRY_DISPATCH_ENABLED !== "1") return null;
  const raw = env.TWILIO_SMS_ACCESS_RETRY_BATCH_SIZE ?? "";
  if (!/^\d+$/.test(raw)) fail("SETTINGS_INVALID");
  const batchSize = Number(raw);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 50) fail("SETTINGS_INVALID");
  return { batchSize };
}

async function currentReadiness(tx: any, scope: SmsRecoveryScope) {
  const message = await tx.messageLog.findUnique({
    where: { id: scope.messageLogId },
    select: { accessGrantId: true, communicationType: true, to: true },
  });
  if (!message || message.communicationType !== "GUEST_ACCESS_PASSCODE" || !message.accessGrantId) {
    return { eligible: false, contentValidUntil: new Date(0), nextScheduledMessage: null };
  }
  const grant = await tx.accessGrant.findUnique({
    where: { id: message.accessGrantId },
    include: {
      secureAccessCode: true,
      lock: { select: { propertyId: true, isActive: true } },
      reservation: {
        select: {
          id: true, propertyId: true, status: true, cancelledAt: true,
          guestPhone: true, externalRaw: true, externalProvider: true, externalId: true,
          checkOut: true,
          property: { select: { organizationId: true, status: true } },
        },
      },
    },
  });
  const r = grant?.reservation;
  const code = grant?.secureAccessCode;
  const eligible = Boolean(
    grant && r && code?.accessCodeEnc && code.accessCodeHash &&
    grant.status === "ACTIVE" && grant.lock?.isActive === true &&
    grant.lock.propertyId === scope.propertyId &&
    grant.reservationId === scope.reservationId &&
    r.id === scope.reservationId && r.propertyId === scope.propertyId &&
    r.property.organizationId === scope.organizationId && r.property.status === "ACTIVE" &&
    r.status === "ACTIVE" && r.cancelledAt === null &&
    r.guestPhone?.trim() && message.to.trim() === r.guestPhone.trim() &&
    isGuestOperationalSmsEligible(r) &&
    grant.endsAt > grant.startsAt && grant.endsAt <= r.checkOut &&
    code.expiresAt.getTime() === grant.endsAt.getTime()
  );
  return {
    eligible,
    contentValidUntil: grant?.endsAt ?? new Date(0),
    nextScheduledMessage: null,
  };
}

async function loadCurrentAccessPayload(db: PrismaClient, scope: SmsRecoveryScope, now: Date) {
  const message = await db.messageLog.findUnique({
    where: { id: scope.messageLogId },
    select: { accessGrantId: true, communicationType: true, to: true },
  });
  if (!message?.accessGrantId || message.communicationType !== "GUEST_ACCESS_PASSCODE") return fail("SOURCE_CHANGED");
  const grant = await db.accessGrant.findUnique({
    where: { id: message.accessGrantId },
    include: {
      secureAccessCode: true,
      lock: { select: { propertyId: true, isActive: true } },
      reservation: {
        select: {
          id: true, propertyId: true, status: true, cancelledAt: true, guestName: true,
          guestPhone: true, preferredLanguage: true, externalRaw: true, externalProvider: true,
          externalId: true, checkOut: true,
          property: { select: { organizationId: true, status: true, timezone: true } },
        },
      },
    },
  });
  const r = grant?.reservation, code = grant?.secureAccessCode;
  if (!grant || !r || !code?.accessCodeEnc || !code.accessCodeHash ||
      grant.status !== "ACTIVE" || !grant.lock?.isActive ||
      grant.lock.propertyId !== scope.propertyId || grant.reservationId !== scope.reservationId ||
      r.id !== scope.reservationId || r.propertyId !== scope.propertyId ||
      r.property.organizationId !== scope.organizationId || r.property.status !== "ACTIVE" ||
      r.status !== "ACTIVE" || r.cancelledAt !== null || !r.guestPhone?.trim() ||
      message.to.trim() !== r.guestPhone.trim() || !isGuestOperationalSmsEligible(r) ||
      now >= grant.endsAt || now >= r.checkOut || grant.endsAt > r.checkOut ||
      code.expiresAt.getTime() !== grant.endsAt.getTime()) return fail("CURRENT_READINESS_LOST");
  const plain = decryptAccessCode(code.accessCodeEnc).trim();
  if (!plain || hashAccessCode(plain) !== code.accessCodeHash) return fail("ACCESS_CODE_INTEGRITY_FAILED");
  const body = buildGuestPasscodeSmsBody({
    guestName: r.guestName,
    code: plain,
    validUntil: grant.endsAt,
    ...(r.property.timezone ? { timezone: r.property.timezone } : {}),
    language: resolveGuestLanguage(r.preferredLanguage),
  });
  return { to: r.guestPhone.trim(), body };
}

/** Executes only already-due, persisted access-message recovery claims.
 * Claim consumes the sole budget before provider I/O. Current recipient, consent,
 * grant and encrypted credential are checked again after the claim. An uncertain
 * provider call records OUTCOME_UNKNOWN and is never blindly repeated.
 */
export async function dispatchDueAccessSmsRetries(
  db: PrismaClient,
  settings: AccessSmsRetryDispatcherSettings,
  clock: () => Date = () => new Date(),
  send: typeof sendSms = sendSms
) {
  if (!Number.isSafeInteger(settings.batchSize) || settings.batchSize < 1 || settings.batchSize > 50) {
    fail("SETTINGS_INVALID");
  }
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("CLOCK_INVALID");
  const due = await db.$queryRawUnsafe<Due[]>(`
    SELECT r."messageLogId",r."organizationId",r."propertyId",r."reservationId",
      r."originalProviderMessageId"
    FROM "TwilioSmsRecovery" r
    JOIN "MessageLog" m ON m."id"=r."messageLogId"
    WHERE r."state"='AVAILABLE' AND r."retriesUsed"=0 AND r."retryNotBefore" <= $1
      AND m."communicationType"='GUEST_ACCESS_PASSCODE'
    ORDER BY r."retryNotBefore" ASC,r."messageLogId" ASC LIMIT $2`,
    now, settings.batchSize
  );
  let submitted = 0, held = 0, reviewed = 0, unknown = 0;
  const store: SmsRecoveryDatabase = { $transaction: work => db.$transaction(tx => work(tx)) };
  for (const row of due) {
    const scope: SmsRecoveryScope = { ...row };
    const claim = await claimTwilioSmsRecovery(store, scope,
      (tx, s) => currentReadiness(tx, s), clock);
    if (claim.kind !== "CLAIMED") {
      held += 1;
      continue;
    }
    try {
      const at = clock();
      if (!(at instanceof Date) || !Number.isFinite(at.getTime()) || at >= claim.validUntil) {
        await recordTwilioSmsRetrySubmission(store, scope, claim.claimToken, null, clock);
        unknown += 1;
        continue;
      }
      const payload = await loadCurrentAccessPayload(db, scope, at);
      const response = await send(payload.to, payload.body);
      const providerSid = String(response?.sid ?? "").trim();
      if (!/^SM[0-9a-fA-F]{32}$/.test(providerSid)) {
        await recordTwilioSmsRetrySubmission(store, scope, claim.claimToken, null, clock);
        unknown += 1;
        continue;
      }
      await recordTwilioSmsRetrySubmission(store, scope, claim.claimToken, providerSid, clock);
      submitted += 1;
    } catch {
      // Provider may have accepted the request before the local exception. Never
      // restore the retry budget or issue another automatic send for this claim.
      await recordTwilioSmsRetrySubmission(store, scope, claim.claimToken, null, clock)
        .catch(() => {});
      reviewed += 1;
    }
  }
  return { scanned: due.length, submitted, held, reviewed, unknown };
}
