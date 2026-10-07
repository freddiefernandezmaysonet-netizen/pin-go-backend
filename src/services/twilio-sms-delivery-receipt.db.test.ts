import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import Twilio from "twilio";
import { PrismaClient } from "@prisma/client";
import { buildMessageDeliveryWebhookRouter } from "../routes/message-delivery.webhooks.routes.js";
import {
  persistTwilioSmsDeliveryReceipt as persist,
  reconcileTwilioSmsDeliveryReceipt as reconcile,
  resolveTwilioSmsRecoverySettings,
} from "./twilio-sms-delivery-receipt.service.js";
import { claimTwilioSmsRecovery } from "./twilio-sms-recovery.store.js";
import type { ProviderDeliveryOutcome } from "./guest-journey-communications-delivery-outcome.service.js";

const expected = "postgresql://ci:ci@127.0.0.1:5432/pin_go_twilio_sms_recovery";
if (process.env.DATABASE_URL !== expected || process.env.TWILIO_RECOVERY_DISPOSABLE_DB !== "1") {
  throw new Error("DISPOSABLE_TWILIO_RECEIPT_DATABASE_REQUIRED");
}
const db = new PrismaClient();
const ACCOUNT = "AC" + "a".repeat(32);
const otherAccount = "AC" + "b".repeat(32);
const first = new Date();
const arrival = new Date(first.getTime() + 4 * 3_600_000);
const departure = new Date(arrival.getTime() + 48 * 3_600_000);
const settings = { delayMs: 1_800_000, minimumSpacingMs: 900_000 };
const freshSid = () => "SM" + randomBytes(16).toString("hex");
const clock = () => new Date(first);
const event = (sid: string, overrides: Partial<ProviderDeliveryOutcome> = {}): ProviderDeliveryOutcome => ({
  provider: "twilio", providerMessageId: sid, status: "UNDELIVERED", errorCode: "30005", eventAt: first, ...overrides,
});
let lockCounter = 920_000_000;
async function fixture(type = "GUEST_ACCESS_PASSCODE", sid = freshSid()) {
  const org = await db.organization.create({ data: { name: "Disposable receipt org" } });
  const property = await db.property.create({ data: { organizationId: org.id, name: "Disposable receipt property" } });
  const reservation = await db.reservation.create({ data: {
    propertyId: property.id, guestName: "Offline Guest", guestPhone: "+17875550101",
    guestEmail: null, checkIn: arrival, checkOut: departure,
  } });
  const lock = await db.lock.create({ data: { propertyId: property.id, ttlockLockId: lockCounter++ } });
  const grant = await db.accessGrant.create({ data: { lockId: lock.id, reservationId: reservation.id,
    method: "PASSCODE_TIMEBOUND", status: "ACTIVE", startsAt: arrival, endsAt: departure } });
  const message = await db.messageLog.create({ data: {
    organizationId: org.id, propertyId: property.id, reservationId: reservation.id,
    channel: "sms", provider: "twilio", to: "+17875550101", body: "Synthetic access Code: ****01",
    communicationType: type, providerMessageId: sid, status: "SENT", accessGrantId: grant.id, createdAt: first,
  } });
  return { org, property, reservation, lock, grant, message, sid };
}
const log = (id: string) => db.messageLog.findUniqueOrThrow({ where: { id } });
const journal = (id: string) => db.twilioSmsRecovery.findUnique({ where: { messageLogId: id } });
const issues = (id: string) => db.operationalIssue.findMany({ where: { reservationId: id } });
async function receipt(id: string) {
  const [r] = await db.$queryRawUnsafe<Array<{ disposition: string }>>(
    'SELECT * FROM "TwilioSmsDeliveryReceipt" WHERE "id"=$1', id);
  return r;
}

test("signed callback persistence and host gap on disposable PostgreSQL", async t => {
  t.after(() => db.$disconnect());

  await t.test("PRECHECKIN records 30005 and a retry without immediate host action", async () => {
    const f = await fixture("PRECHECKIN");
    const result = await persist(db, ACCOUNT, event(f.sid), settings, clock);
    assert.equal(result.disposition, "APPLIED");
    const m = await log(f.message.id);
    assert.equal(m.status, "SENT"); assert.equal(m.providerDeliveryStatus, "UNDELIVERED");
    assert.equal(m.providerErrorCode, "30005"); assert.equal(m.deliveredAt, null);
    assert.equal(m.providerMessageId, f.sid); assert.equal(m.retryCount, 0);
    assert.equal((await journal(m.id))?.state, "AVAILABLE");
    assert.equal((await issues(f.reservation.id)).length, 0);
  });
  await t.test("access SMS plus missing email creates one critical issue and preserves a claimable retry", async () => {
    const f = await fixture();
    const snapshot = await db.reservation.findUniqueOrThrow({ where: { id: f.reservation.id } });
    await persist(db, ACCOUNT, event(f.sid), settings, clock);
    const rows = await issues(f.reservation.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.severity, "CRITICAL"); assert.equal(rows[0]?.visibility, "HOST");
    assert.equal(rows[0]?.workflowState, "ACTION_REQUIRED");
    assert.equal((await journal(f.message.id))?.retriesUsed, 0);
    const claim = await claimTwilioSmsRecovery({ $transaction: work => db.$transaction(tx => work(tx)) }, {
      messageLogId: f.message.id, organizationId: f.org.id, propertyId: f.property.id,
      reservationId: f.reservation.id, originalProviderMessageId: f.sid,
    }, async () => ({ eligible: true, contentValidUntil: departure, nextScheduledMessage: null }),
    () => new Date(first.getTime() + settings.delayMs));
    assert.equal(claim.kind, "CLAIMED");
    assert.deepEqual(await db.reservation.findUnique({ where: { id: f.reservation.id } }), snapshot);
    assert.doesNotMatch(JSON.stringify(rows), /17875550101|Synthetic access|\*\*\*\*/);
  });
  await t.test("eight duplicate callbacks preserve one receipt, one transition and the original delay", async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => persist(db, ACCOUNT, event(f.sid), settings, clock)));
    assert.equal(new Set(results.map(r => r.receiptId)).size, 1);
    const rows = await issues(f.reservation.id);
    assert.equal(rows.length, 1);
    assert.equal(await db.operationalIssueTransition.count({ where: { issueId: rows[0]!.id } }), 1);
    const before = await journal(f.message.id);
    await persist(db, ACCOUNT, event(f.sid, { eventAt: new Date(first.getTime() + 60_000) }),
      { delayMs: 3_600_000, minimumSpacingMs: 60_000 }, () => new Date(first.getTime() + 60_000));
    assert.deepEqual(await journal(f.message.id), before);
    assert.equal((await log(f.message.id)).providerStatusUpdatedAt?.getTime(), first.getTime());
  });
  await t.test("a resolved host action is never reopened by the same receipt", async () => {
    const f = await fixture();
    await persist(db, ACCOUNT, event(f.sid), settings, clock);
    const issue = (await issues(f.reservation.id))[0]!;
    await db.operationalIssue.update({ where: { id: issue.id }, data: {
      workflowState: "RESOLVED", actionRequired: false, resolvedAt: first,
    } });
    await persist(db, ACCOUNT, event(f.sid), settings, clock);
    assert.equal((await issues(f.reservation.id))[0]?.workflowState, "RESOLVED");
    assert.equal(await db.operationalIssueTransition.count({ where: { issueId: issue.id } }), 1);
  });
  await t.test("early unmatched receipt survives and exact replay correlates after MessageLog exists", async () => {
    const sid = freshSid();
    const result = await persist(db, ACCOUNT, event(sid), settings, clock);
    assert.equal(result.disposition, "UNMATCHED");
    const f = await fixture("PRECHECKIN", sid);
    assert.equal((await reconcile(db, result.receiptId, ACCOUNT, settings, clock)).disposition, "APPLIED");
    assert.equal((await log(f.message.id)).providerErrorCode, "30005");
    await assert.rejects(reconcile(db, result.receiptId, otherAccount, settings, clock), /NOT_FOUND/);
  });
  await t.test("ambiguous provider mapping is retained without mutating either message", async () => {
    const f = await fixture("PRECHECKIN"), g = await fixture("PRECHECKIN", f.sid);
    const result = await persist(db, ACCOUNT, event(f.sid), settings, clock);
    assert.equal(result.disposition, "AMBIGUOUS");
    assert.equal((await log(f.message.id)).providerDeliveryStatus, null);
    assert.equal((await log(g.message.id)).providerDeliveryStatus, null);
    assert.equal(await journal(f.message.id), null);
  });
  await t.test("late SENT cannot erase a terminal failure", async () => {
    const f = await fixture("PRECHECKIN");
    await persist(db, ACCOUNT, event(f.sid), settings, clock);
    const result = await persist(db, ACCOUNT, event(f.sid, { status: "SENT", errorCode: null }), settings, clock);
    assert.equal(result.disposition, "IGNORED_OLDER_STATE");
    assert.equal((await log(f.message.id)).providerErrorCode, "30005");
  });
  await t.test("duplicate failure without code does not erase the code or reset the anchor", async () => {
    const f = await fixture("PRECHECKIN");
    await persist(db, ACCOUNT, event(f.sid), settings, clock);
    await persist(db, ACCOUNT, event(f.sid, { errorCode: null, eventAt: new Date(first.getTime() + 60_000) }),
      settings, () => new Date(first.getTime() + 60_000));
    assert.equal((await log(f.message.id)).providerErrorCode, "30005");
    assert.equal((await journal(f.message.id))?.firstFailureAt.getTime(), first.getTime());
  });
  await t.test("contradictory delivery is retained for review and cannot authorize another send", async () => {
    const f = await fixture("PRECHECKIN");
    await persist(db, ACCOUNT, event(f.sid), settings, clock);
    const result = await persist(db, ACCOUNT, event(f.sid, { status: "DELIVERED", errorCode: null }), settings, clock);
    assert.equal(result.disposition, "CONFLICT");
    assert.equal((await log(f.message.id)).providerDeliveryStatus, "UNDELIVERED");
    assert.equal((await journal(f.message.id))?.state, "REVIEW");
  });
  await t.test("an ordinary delivered receipt remains separate from local SENT", async () => {
    const f = await fixture();
    await persist(db, ACCOUNT, event(f.sid, { status: "DELIVERED", errorCode: null }), settings, clock);
    assert.equal((await log(f.message.id)).status, "SENT");
    assert.equal((await log(f.message.id)).deliveredAt?.getTime(), first.getTime());
    assert.equal(await journal(f.message.id), null);
    assert.equal((await issues(f.reservation.id)).length, 0);
  });
  for (const condition of ["CANCELLED", "ENDED", "WRONG_SCOPE", "CHANGED_PHONE", "HAS_EMAIL"]) {
    await t.test(`${condition}: persist delivery truth without a fabricated missing-email incident`, async () => {
      const f = await fixture();
      if (condition === "CANCELLED") await db.reservation.update({ where: { id: f.reservation.id }, data: { status: "CANCELLED" } });
      if (condition === "ENDED") await db.reservation.update({ where: { id: f.reservation.id }, data: {
        checkIn: new Date(first.getTime() - 3_600_000), checkOut: first,
      } });
      if (condition === "WRONG_SCOPE") await db.messageLog.update({ where: { id: f.message.id }, data: { organizationId: "foreign-org" } });
      if (condition === "CHANGED_PHONE") await db.reservation.update({ where: { id: f.reservation.id }, data: { guestPhone: "+17875550999" } });
      if (condition === "HAS_EMAIL") await db.reservation.update({ where: { id: f.reservation.id }, data: { guestEmail: "offline@example.invalid" } });
      await persist(db, ACCOUNT, event(f.sid), settings, clock);
      assert.equal((await log(f.message.id)).providerErrorCode, "30005");
      assert.equal((await issues(f.reservation.id)).length, 0);
      if (condition !== "HAS_EMAIL") assert.equal(await journal(f.message.id), null);
    });
  }
  await t.test("a failed history write rolls back outcome, retry and incident but retains the inbox receipt", async () => {
    const f = await fixture();
    const faulty = new Proxy(db, { get(target, prop) {
      if (prop === "$transaction") return (work: (tx: unknown) => Promise<unknown>) => db.$transaction(async tx => {
        const proxy = new Proxy(tx, { get(inner, key) {
          if (key === "operationalIssueTransition") return { create: async () => { throw new Error("INJECTED_HISTORY_FAILURE"); } };
          return Reflect.get(inner, key);
        } });
        return work(proxy);
      });
      return Reflect.get(target, prop);
    } });
    await assert.rejects(persist(faulty, ACCOUNT, event(f.sid), settings, clock), /INJECTED_HISTORY_FAILURE/);
    assert.equal((await log(f.message.id)).providerDeliveryStatus, null);
    assert.equal(await journal(f.message.id), null);
    assert.equal((await issues(f.reservation.id)).length, 0);
    const retained = await db.$queryRawUnsafe<Array<{ id: string; disposition: string }>>(
      'SELECT "id","disposition" FROM "TwilioSmsDeliveryReceipt" WHERE "providerMessageId"=$1', f.sid);
    assert.equal(retained.length, 1); assert.equal(retained[0]?.disposition, "PENDING");
    await reconcile(db, retained[0]!.id, ACCOUNT, settings, clock);
    assert.equal((await issues(f.reservation.id)).length, 1);
  });
  await t.test("receipt and incident metadata never copy arbitrary provider text or SMS body", async () => {
    const f = await fixture();
    const result = await persist(db, ACCOUNT, event(f.sid, { errorMessage: "PRIVATE_PROVIDER_TOKEN_AND_PHONE" }), settings, clock);
    assert.doesNotMatch(JSON.stringify(await receipt(result.receiptId)), /PRIVATE_PROVIDER|Synthetic access|17875550101/);
    assert.doesNotMatch(JSON.stringify(await issues(f.reservation.id)), /PRIVATE_PROVIDER|Synthetic access|17875550101/);
  });
  await t.test("configuration is explicit, bounded and off without the new flag", () => {
    assert.equal(resolveTwilioSmsRecoverySettings({}), null);
    assert.throws(() => resolveTwilioSmsRecoverySettings({ TWILIO_SMS_RECOVERY_ENABLED: "1" }), /SETTINGS_INVALID/);
    assert.deepEqual(resolveTwilioSmsRecoverySettings({ TWILIO_SMS_RECOVERY_ENABLED: "1",
      TWILIO_SMS_RETRY_DELAY_MINUTES: "30", TWILIO_SMS_MINIMUM_SPACING_MINUTES: "15" }), settings);
  });
  await t.test("signed HTTP rejects tampering and foreign account before any persistence, then accepts one valid receipt", async () => {
    const f = await fixture();
    const token = "offline-signature-fixture-only";
    const signedUrl = "https://callback.example.invalid/webhooks/delivery/twilio";
    const env = { NODE_ENV: "production", MESSAGE_DELIVERY_WEBHOOKS_ENABLED: "1", TWILIO_AUTH_TOKEN: token,
      TWILIO_ACCOUNT_SID: ACCOUNT, PUBLIC_API_BASE_URL: "https://callback.example.invalid",
      TWILIO_SMS_RECOVERY_ENABLED: "1", TWILIO_SMS_RETRY_DELAY_MINUTES: "30", TWILIO_SMS_MINIMUM_SPACING_MINUTES: "15" };
    const app = express(); app.use(express.urlencoded({ extended: false }));
    app.use(buildMessageDeliveryWebhookRouter(db, env));
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/delivery/twilio`;
      const params = { AccountSid: ACCOUNT, MessageSid: f.sid, MessageStatus: "undelivered", ErrorCode: "30005", FutureProviderField: "valid-extra-field" };
      const post = (body: Record<string, string>, signature: string) => fetch(url, { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
        body: new URLSearchParams(body) });
      assert.equal((await post(params, "bad-signature")).status, 403);
      const foreign = { ...params, AccountSid: otherAccount };
      assert.equal((await post(foreign, Twilio.getExpectedTwilioSignature(token, signedUrl, foreign))).status, 403);
      assert.equal((await log(f.message.id)).providerDeliveryStatus, null);
      assert.equal((await issues(f.reservation.id)).length, 0);
      const result = await post(params, Twilio.getExpectedTwilioSignature(token, signedUrl, params));
      assert.equal(result.status, 204);
      assert.equal((await log(f.message.id)).providerErrorCode, "30005");
      assert.equal((await issues(f.reservation.id)).length, 1);
    } finally {
      server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    }
  });
});
