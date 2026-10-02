import { createHash, randomUUID } from "node:crypto";
import {
  evaluateTwilioSmsFailure,
  smsFailureOperationalKey,
  type ExistingSmsFailureIssue,
  type SmsFailureDecision,
  type SmsRetryEvidence,
} from "./twilio-sms-failure.policy.js";

/** Internal DB adapter. No provider I/O is allowed inside its transactions. */
export interface SmsRecoveryTransaction {
  $queryRawUnsafe<T = unknown>(sql: string, ...parameters: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...parameters: unknown[]): Promise<number>;
}
export interface SmsRecoveryDatabase {
  $transaction<T>(work: (tx: SmsRecoveryTransaction) => Promise<T>): Promise<T>;
}
export type SmsRecoveryScope = {
  messageLogId: string;
  organizationId: string;
  propertyId: string;
  reservationId: string;
  originalProviderMessageId: string;
};
export type SmsRecoverySettings = { delayMs: number; minimumSpacingMs: number };
export type SmsRecoveryReadiness = {
  /** Must include current consent, recipient, content and access-release checks. */
  eligible: boolean;
  contentValidUntil: Date;
  nextScheduledMessage: SmsRetryEvidence["nextScheduledMessage"];
};
export type SmsRecoveryReadinessReader = (
  tx: SmsRecoveryTransaction,
  scope: Readonly<SmsRecoveryScope>
) => Promise<SmsRecoveryReadiness>;

type Journal = SmsRecoveryScope & {
  state: string;
  retriesUsed: number;
  firstFailureAt: Date;
  retryNotBefore: Date;
  minimumSpacingMs: number;
  sourceFingerprint: string;
  claimToken: string | null;
  retryProviderMessageId: string | null;
};
type Source = {
  messageLogId: string;
  organizationId: string;
  propertyId: string;
  reservationId: string;
  providerMessageId: string | null;
  provider: string | null;
  channel: string;
  communicationType: string | null;
  sendAttemptStatus: string | null;
  providerDeliveryStatus: string | null;
  providerErrorCode: string | null;
  providerStatusUpdatedAt: Date | null;
  retryCount: number;
  to: string;
  body: string;
  guestPhone: string | null;
  accessGrantId: string | null;
  status: string;
  cancelledAt: Date | null;
  checkIn: Date;
  checkOut: Date;
  propertyStatus: string;
};
const id = (s: string) => typeof s === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(s);
const sid = (s: string) => typeof s === "string" && /^SM[0-9a-fA-F]{32}$/.test(s);
const date = (d: Date | null): d is Date => d instanceof Date && Number.isFinite(d.getTime());
const fail = (code: string): never => { throw new Error(`SMS_RECOVERY_${code}`); };
function validateScope(s: SmsRecoveryScope) {
  if (![s.messageLogId, s.organizationId, s.propertyId, s.reservationId].every(id) ||
      !sid(s.originalProviderMessageId)) fail("INVALID_SCOPE");
}
function validateSettings(s: SmsRecoverySettings) {
  if (!Number.isSafeInteger(s.delayMs) || s.delayMs < 60_000 || s.delayMs > 86_400_000 ||
      !Number.isSafeInteger(s.minimumSpacingMs) || s.minimumSpacingMs < 60_000 ||
      s.minimumSpacingMs > 3_600_000) fail("INVALID_SETTINGS");
}
function fingerprint(s: Source): string {
  return createHash("sha256").update(JSON.stringify([
    s.to, s.guestPhone, s.body, s.communicationType, s.accessGrantId,
    s.checkIn.toISOString(), s.checkOut.toISOString(),
  ])).digest("hex");
}
function sameScope(j: Journal, s: SmsRecoveryScope) {
  if (j.messageLogId !== s.messageLogId || j.organizationId !== s.organizationId ||
      j.propertyId !== s.propertyId || j.reservationId !== s.reservationId ||
      j.originalProviderMessageId !== s.originalProviderMessageId) fail("JOURNAL_SCOPE_MISMATCH");
}
async function lockedJournal(tx: SmsRecoveryTransaction, s: SmsRecoveryScope) {
  await tx.$executeRawUnsafe(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", `sms-recovery:${s.messageLogId}`
  );
  const [j] = await tx.$queryRawUnsafe<Journal[]>(
    'SELECT * FROM "TwilioSmsRecovery" WHERE "messageLogId" = $1 FOR UPDATE', s.messageLogId
  );
  if (j) sameScope(j, s);
  return j ?? null;
}
async function lockedSource(tx: SmsRecoveryTransaction, s: SmsRecoveryScope): Promise<Source> {
  const [m] = await tx.$queryRawUnsafe<Source[]>(`
    SELECT m."id" AS "messageLogId", m."organizationId", m."propertyId", m."reservationId",
      m."providerMessageId", m."provider", m."channel", m."communicationType",
      m."status" AS "sendAttemptStatus", m."providerDeliveryStatus", m."providerErrorCode",
      m."providerStatusUpdatedAt", m."retryCount", m."to", m."body", m."accessGrantId",
      r."guestPhone", r."status", r."cancelledAt", r."checkIn", r."checkOut",
      p."status" AS "propertyStatus"
    FROM "MessageLog" m JOIN "Reservation" r ON r."id" = m."reservationId"
    JOIN "Property" p ON p."id" = r."propertyId"
    WHERE m."id" = $1 AND m."organizationId" = $2 AND m."propertyId" = $3
      AND m."reservationId" = $4 AND p."organizationId" = $2 AND p."id" = $3
    FOR UPDATE OF m, r, p`, s.messageLogId, s.organizationId, s.propertyId, s.reservationId);
  if (!m) return fail("SOURCE_SCOPE_MISMATCH");
  if (m.provider !== "twilio" || m.channel !== "sms" ||
      m.providerMessageId !== s.originalProviderMessageId) fail("SOURCE_ATTEMPT_CHANGED");
  const mappings = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT "id" FROM "MessageLog" WHERE "provider" = $1 AND "providerMessageId" = $2 LIMIT 2',
    "twilio", s.originalProviderMessageId
  );
  if (mappings.length !== 1 || mappings[0]?.id !== s.messageLogId) fail("AMBIGUOUS_PROVIDER_SID");
  if (!date(m.checkIn) || !date(m.checkOut) || m.checkOut <= m.checkIn) fail("SOURCE_DATES_INVALID");
  return m;
}
async function transact<T>(db: SmsRecoveryDatabase, work: (tx: SmsRecoveryTransaction) => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(work); }
    catch (error) {
      const e = error as { code?: string; meta?: { code?: string } };
      const retryable = e?.code === "P2034" || ["40001", "40P01"].includes(e?.meta?.code ?? "");
      if (!retryable || attempt === 2) throw error;
    }
  }
}
function nowFrom(clock: () => Date) {
  const now = clock();
  if (!date(now)) return fail("INVALID_CLOCK");
  return now;
}

/** Register only an already persisted, correlated 30005. Not an HTTP receiver. */
export async function registerTwilioSmsRecovery(
  db: SmsRecoveryDatabase, scope: SmsRecoveryScope, settings: SmsRecoverySettings,
  clock: () => Date = () => new Date()
) {
  validateScope(scope); validateSettings(settings);
  return transact(db, async tx => {
    const existing = await lockedJournal(tx, scope);
    if (existing) return { created: false, state: existing.state };
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      `sms-recovery-sid:${scope.originalProviderMessageId}`);
    const reused = await tx.$queryRawUnsafe<Array<{ messageLogId: string }>>(
      'SELECT "messageLogId" FROM "TwilioSmsRecovery" WHERE "retryProviderMessageId"=$1 LIMIT 1',
      scope.originalProviderMessageId);
    if (reused.length) fail("PROVIDER_SID_ALREADY_USED");
    const m = await lockedSource(tx, scope);
    const now = nowFrom(clock);
    if (!["UNDELIVERED", "FAILED"].includes(m.providerDeliveryStatus ?? "") ||
        m.providerErrorCode !== "30005") fail("NO_PERSISTED_30005");
    if (m.retryCount !== 0) fail("PRIOR_RETRY_HISTORY_REQUIRES_REVIEW");
    if (!date(m.providerStatusUpdatedAt) || m.providerStatusUpdatedAt > now) return fail("FAILURE_TIME_INVALID");
    if (!["PRECHECKIN", "GUEST_ACCESS_PASSCODE"].includes(m.communicationType ?? "")) fail("TYPE_UNSUPPORTED");
    if (m.status !== "ACTIVE" || m.cancelledAt !== null || m.propertyStatus !== "ACTIVE" ||
        now >= (m.communicationType === "PRECHECKIN" ? m.checkIn : m.checkOut)) fail("MESSAGE_NOT_CURRENT");
    if (!m.guestPhone?.trim() || m.to.trim() !== m.guestPhone.trim()) fail("RECIPIENT_CHANGED");
    const notBefore = new Date(m.providerStatusUpdatedAt.getTime() + settings.delayMs);
    if (!date(notBefore)) fail("INVALID_SETTINGS");
    await tx.$executeRawUnsafe(`INSERT INTO "TwilioSmsRecovery"
      ("messageLogId", "organizationId", "propertyId", "reservationId", "originalProviderMessageId",
       "originalDeliveryStatus", "originalErrorCode", "firstFailureAt", "retryNotBefore",
       "minimumSpacingMs", "sourceFingerprint", "createdAt", "updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,'30005',$7,$8,$9,$10,$11,$11)`,
      scope.messageLogId, scope.organizationId, scope.propertyId, scope.reservationId,
      scope.originalProviderMessageId, m.providerDeliveryStatus, m.providerStatusUpdatedAt,
      notBefore, settings.minimumSpacingMs, fingerprint(m), now);
    return { created: true, state: "AVAILABLE" };
  });
}

export type SmsRecoveryClaimResult =
  | { kind: "HELD"; state: string; blockOtherScheduledMessages: false }
  | { kind: "DECISION"; decision: SmsFailureDecision }
  | { kind: "CLAIMED"; claimToken: string; recoveryKey: string; validUntil: Date;
      blockOtherScheduledMessages: false };

/** Consume the only retry before any external call. A claim is NOT send authorization:
 * the future dispatcher must revalidate at its provider boundary and never replay a
 * claim after an ambiguous crash. validateCurrent must be server-owned and DB-only.
 */
export async function claimTwilioSmsRecovery(
  db: SmsRecoveryDatabase, scope: SmsRecoveryScope, validateCurrent: SmsRecoveryReadinessReader,
  clock: () => Date = () => new Date()
): Promise<SmsRecoveryClaimResult> {
  validateScope(scope);
  return transact(db, async tx => {
    const j = await lockedJournal(tx, scope);
    if (!j) return fail("JOURNAL_MISSING");
    if (j.state !== "AVAILABLE" || j.retriesUsed !== 0) {
      return { kind: "HELD", state: j.state, blockOtherScheduledMessages: false };
    }
    const m = await lockedSource(tx, scope);
    const [existingIssue] = await tx.$queryRawUnsafe<ExistingSmsFailureIssue[]>(
      `SELECT "operationalKey", "organizationId", "propertyId", "reservationId", "workflowState"
       FROM "OperationalIssue" WHERE "operationalKey" = $1 FOR UPDATE`,
      smsFailureOperationalKey(scope.messageLogId, scope.originalProviderMessageId)
    );
    const readiness = await validateCurrent(tx, Object.freeze({ ...scope }));
    const now = nowFrom(clock); // Read after lock wait and readiness work, never before.
    const decision = evaluateTwilioSmsFailure({
      message: { ...m, provider: "twilio" },
      reservation: { ...m, id: m.reservationId },
      existingIssue: existingIssue ?? null,
      recovery: {
        messageLogId: scope.messageLogId, providerMessageId: scope.originalProviderMessageId,
        retriesUsed: j.retriesUsed, retryState: "AVAILABLE", firstFailureAt: j.firstFailureAt,
        retryNotBefore: j.retryNotBefore, minimumSpacingMs: j.minimumSpacingMs,
        contentValidUntil: readiness.contentValidUntil, nextScheduledMessage: readiness.nextScheduledMessage,
        currentRecipientAndContent: readiness.eligible === true && m.propertyStatus === "ACTIVE" &&
          m.retryCount === 0 && Boolean(m.guestPhone?.trim()) && m.to.trim() === m.guestPhone?.trim() &&
          fingerprint(m) === j.sourceFingerprint,
      }, now,
    });
    if (decision.kind === "RETRY_ELIGIBLE" && decision.retryPlan) {
      const claimToken = randomUUID();
      const changed = await tx.$executeRawUnsafe(`UPDATE "TwilioSmsRecovery"
        SET "state"='CLAIMED', "retriesUsed"=1, "claimToken"=$2, "claimedAt"=$3,
          "validUntil"=$4, "updatedAt"=$3, "lastDecision"=$5
        WHERE "messageLogId"=$1 AND "state"='AVAILABLE' AND "retriesUsed"=0`,
        scope.messageLogId, claimToken, now, decision.retryPlan.validUntil, decision.reason);
      if (changed !== 1) return fail("CLAIM_LOST");
      return { kind: "CLAIMED", claimToken, recoveryKey: decision.retryPlan.recoveryKey,
        validUntil: new Date(decision.retryPlan.validUntil), blockOtherScheduledMessages: false };
    }
    const state = decision.kind === "WAIT_FOR_RETRY" ? "AVAILABLE"
      : decision.kind === "WAIT_FOR_NEXT_MESSAGE" ? "YIELDED"
      : decision.deliveryConfirmed ? "DELIVERED"
      : ["MESSAGE_EXPIRED", "STAY_ENDED", "RESERVATION_CANCELLED"].includes(decision.reason) ? "EXPIRED" : "REVIEW";
    await tx.$executeRawUnsafe(`UPDATE "TwilioSmsRecovery" SET "state"=$2, "lastDecision"=$3,
      "nextMessageKey"=$4, "nextMessageAt"=$5, "updatedAt"=$6 WHERE "messageLogId"=$1`,
      scope.messageLogId, state, decision.reason,
      state === "YIELDED" ? readiness.nextScheduledMessage?.messageKey ?? null : null,
      state === "YIELDED" ? readiness.nextScheduledMessage?.scheduledAt ?? null : null, now);
    return { kind: "DECISION", decision };
  });
}

/** Persist a trusted provider response, or uncertainty, without modifying the
 * original MessageLog/SID. Replaying this method never makes another SMS call.
 * A late response can reconcile OUTCOME_UNKNOWN, but can never restore budget.
 */
export async function recordTwilioSmsRetrySubmission(
  db: SmsRecoveryDatabase, scope: SmsRecoveryScope, claimToken: string,
  providerMessageId: string | null, clock: () => Date = () => new Date()
) {
  validateScope(scope);
  if (!/^[0-9a-f-]{36}$/.test(claimToken) ||
      (providerMessageId !== null && (!sid(providerMessageId) ||
       providerMessageId === scope.originalProviderMessageId))) fail("INVALID_SUBMISSION");
  return transact(db, async tx => {
    const j = await lockedJournal(tx, scope);
    if (!j || j.retriesUsed !== 1 || j.claimToken !== claimToken) return fail("CLAIM_MISMATCH");
    if (j.state === "SUBMITTED") {
      if (j.retryProviderMessageId !== providerMessageId) fail("SUBMISSION_CHANGED");
      return { state: "SUBMITTED", changed: false };
    }
    if (!["CLAIMED", "OUTCOME_UNKNOWN"].includes(j.state)) fail("STATE_NOT_SUBMITTABLE");
    if (providerMessageId) {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        `sms-recovery-sid:${providerMessageId}`);
      const other = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT "id" FROM "MessageLog" WHERE "provider"=$1 AND "providerMessageId"=$2 LIMIT 1',
        "twilio", providerMessageId);
      const original = await tx.$queryRawUnsafe<Array<{ messageLogId: string }>>(
        'SELECT "messageLogId" FROM "TwilioSmsRecovery" WHERE "originalProviderMessageId"=$1 LIMIT 1',
        providerMessageId);
      if (other.length || original.length) fail("PROVIDER_SID_ALREADY_USED");
    }
    const state = providerMessageId ? "SUBMITTED" : "OUTCOME_UNKNOWN";
    await tx.$executeRawUnsafe(`UPDATE "TwilioSmsRecovery" SET "state"=$2,
      "retryProviderMessageId"=$3, "updatedAt"=$4 WHERE "messageLogId"=$1`,
      scope.messageLogId, state, providerMessageId, nowFrom(clock));
    return { state, changed: true };
  });
}
