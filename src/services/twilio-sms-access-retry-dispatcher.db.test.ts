import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { encryptAccessCode, hashAccessCode } from "./access-code-crypto.service.js";
import {
  dispatchDueAccessSmsRetries,
  resolveAccessSmsRetryDispatcherSettings,
} from "./twilio-sms-access-retry-dispatcher.service.js";
import { registerTwilioSmsRecovery, type SmsRecoveryDatabase } from "./twilio-sms-recovery.store.js";

const expected = "postgresql://ci:ci@127.0.0.1:5432/pin_go_twilio_sms_recovery";
if (process.env.DATABASE_URL !== expected || process.env.TWILIO_RECOVERY_DISPOSABLE_DB !== "1") {
  throw new Error("DISPOSABLE_ACCESS_SMS_RETRY_DATABASE_REQUIRED");
}
process.env.ACCESS_CODE_ENC_KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");
const db = new PrismaClient();
const store: SmsRecoveryDatabase = { $transaction: work => db.$transaction(tx => work(tx)) };
const first = new Date("2026-10-02T18:00:04.000Z");
const due = new Date("2026-10-02T18:30:04.000Z");
const arrival = new Date("2026-10-02T20:00:00.000Z");
const departure = new Date("2026-10-04T15:00:00.000Z");
const settings = { delayMs: 1_800_000, minimumSpacingMs: 900_000 };
const sid = () => "SM" + randomBytes(16).toString("hex");
let lockId = 930_000_000;

async function fixture() {
  const org = await db.organization.create({ data: { name: "Access retry " + randomUUID() } });
  const property = await db.property.create({ data: {
    organizationId: org.id, name: "Offline property", timezone: "America/Puerto_Rico",
  } });
  const reservation = await db.reservation.create({ data: {
    propertyId: property.id, guestName: "Offline guest", guestPhone: "+17875550101",
    externalProvider: "CHANNEX", externalId: "offline-" + randomUUID(),
    checkIn: arrival, checkOut: departure,
  } });
  const lock = await db.lock.create({ data: { propertyId: property.id, ttlockLockId: lockId++ } });
  const grant = await db.accessGrant.create({ data: {
    lockId: lock.id, reservationId: reservation.id, method: "PASSCODE_TIMEBOUND",
    status: "ACTIVE", startsAt: arrival, endsAt: departure,
  } });
  const plain = "7351902";
  await db.accessCode.create({ data: {
    accessGrantId: grant.id, lockId: lock.ttlockLockId, method: "period",
    keyboardPwdId: "123456", startDate: BigInt(arrival.getTime()), endDate: BigInt(departure.getTime()),
    phone: reservation.guestPhone, accessCodeEnc: encryptAccessCode(plain),
    accessCodeHash: hashAccessCode(plain), accessCodeMasked: "73*****", expiresAt: departure,
  } });
  const originalSid = sid();
  const message = await db.messageLog.create({ data: {
    organizationId: org.id, propertyId: property.id, reservationId: reservation.id,
    accessGrantId: grant.id, channel: "sms", provider: "twilio", to: reservation.guestPhone!,
    body: "Pin&Go access. Code: *****02.", communicationType: "GUEST_ACCESS_PASSCODE",
    providerMessageId: originalSid, status: "SENT", providerDeliveryStatus: "UNDELIVERED",
    providerErrorCode: "30005", providerStatusUpdatedAt: first, createdAt: first,
  } });
  const scope = { messageLogId: message.id, organizationId: org.id, propertyId: property.id,
    reservationId: reservation.id, originalProviderMessageId: originalSid };
  await registerTwilioSmsRecovery(store, scope, settings, () => first);
  return { org, property, reservation, lock, grant, message, scope, plain };
}

test("one bounded access SMS retry uses current encrypted credential", async t => {
  t.after(() => db.$disconnect());

  await t.test("due retry decrypts current code, submits one SID and leaves original log unchanged", async () => {
    const f = await fixture();
    const before = await db.messageLog.findUniqueOrThrow({ where: { id: f.message.id } });
    const calls: Array<{ to: string; body: string }> = [];
    const retrySid = sid();
    const result = await dispatchDueAccessSmsRetries(db, { batchSize: 10 }, () => due,
      async (to, body) => { calls.push({ to, body }); return { sid: retrySid, status: "queued" }; });
    assert.equal(result.submitted, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.to, f.reservation.guestPhone);
    assert.match(calls[0]?.body ?? "", new RegExp(f.plain));
    assert.doesNotMatch(before.body, new RegExp(f.plain));
    assert.deepEqual(await db.messageLog.findUnique({ where: { id: f.message.id } }), before);
    const journal = await db.twilioSmsRecovery.findUniqueOrThrow({ where: { messageLogId: f.message.id } });
    assert.equal(journal.retriesUsed, 1); assert.equal(journal.state, "SUBMITTED");
    assert.equal(journal.retryProviderMessageId, retrySid);
    const second = await dispatchDueAccessSmsRetries(db, { batchSize: 10 }, () => due,
      async () => { throw new Error("MUST_NOT_SEND_TWICE"); });
    assert.equal(second.scanned, 0);
  });

  await t.test("recorded OTA opt-out before due time blocks the send without spending retry", async () => {
    const f = await fixture();
    await db.reservation.update({ where: { id: f.reservation.id }, data: {
      externalRaw: { consent: { smsConsent: false } },
    } });
    let calls = 0;
    const result = await dispatchDueAccessSmsRetries(db, { batchSize: 10 }, () => due,
      async () => { calls += 1; return { sid: sid(), status: "queued" }; });
    assert.equal(calls, 0); assert.equal(result.submitted, 0);
    const journal = await db.twilioSmsRecovery.findUniqueOrThrow({ where: { messageLogId: f.message.id } });
    assert.equal(journal.retriesUsed, 0); assert.equal(journal.state, "REVIEW");
  });

  await t.test("revoked access before due time blocks the send", async () => {
    const f = await fixture();
    await db.accessGrant.update({ where: { id: f.grant.id }, data: { status: "REVOKED" } });
    let calls = 0;
    await dispatchDueAccessSmsRetries(db, { batchSize: 10 }, () => due,
      async () => { calls += 1; return { sid: sid(), status: "queued" }; });
    assert.equal(calls, 0);
    assert.equal((await db.twilioSmsRecovery.findUniqueOrThrow({ where: { messageLogId: f.message.id } })).retriesUsed, 0);
  });

  await t.test("provider exception consumes the claimed budget as unknown and never resends", async () => {
    const f = await fixture();
    let calls = 0;
    const firstRun = await dispatchDueAccessSmsRetries(db, { batchSize: 10 }, () => due,
      async () => { calls += 1; throw new Error("SIMULATED_TIMEOUT_AFTER_POSSIBLE_ACCEPT"); });
    assert.equal(calls, 1); assert.equal(firstRun.reviewed, 1);
    const journal = await db.twilioSmsRecovery.findUniqueOrThrow({ where: { messageLogId: f.message.id } });
    assert.equal(journal.retriesUsed, 1); assert.equal(journal.state, "OUTCOME_UNKNOWN");
    await dispatchDueAccessSmsRetries(db, { batchSize: 10 }, () => due,
      async () => { calls += 1; return { sid: sid(), status: "queued" }; });
    assert.equal(calls, 1);
  });

  await t.test("tampered encrypted credential fails closed after claim and cannot send", async () => {
    const f = await fixture();
    await db.accessCode.update({ where: { accessGrantId: f.grant.id }, data: {
      accessCodeEnc: encryptAccessCode("9999999"),
    } });
    let calls = 0;
    const result = await dispatchDueAccessSmsRetries(db, { batchSize: 10 }, () => due,
      async () => { calls += 1; return { sid: sid(), status: "queued" }; });
    assert.equal(calls, 0); assert.equal(result.reviewed, 1);
    const journal = await db.twilioSmsRecovery.findUniqueOrThrow({ where: { messageLogId: f.message.id } });
    assert.equal(journal.retriesUsed, 1); assert.equal(journal.state, "OUTCOME_UNKNOWN");
  });

  await t.test("dispatcher configuration is explicit and bounded", () => {
    assert.equal(resolveAccessSmsRetryDispatcherSettings({}), null);
    assert.throws(() => resolveAccessSmsRetryDispatcherSettings({
      TWILIO_SMS_ACCESS_RETRY_DISPATCH_ENABLED: "1",
    }), /SETTINGS_INVALID/);
    assert.deepEqual(resolveAccessSmsRetryDispatcherSettings({
      TWILIO_SMS_ACCESS_RETRY_DISPATCH_ENABLED: "1",
      TWILIO_SMS_ACCESS_RETRY_BATCH_SIZE: "10",
    }), { batchSize: 10 });
  });
});
