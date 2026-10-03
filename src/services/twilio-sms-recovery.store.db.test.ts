import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  registerTwilioSmsRecovery, claimTwilioSmsRecovery, recordTwilioSmsRetrySubmission,
  type SmsRecoveryDatabase, type SmsRecoveryScope, type SmsRecoveryReadinessReader,
} from "./twilio-sms-recovery.store.js";
import { smsFailureOperationalKey } from "./twilio-sms-failure.policy.js";

// This suite refuses all persistent databases and never imports an app entrypoint.
const expected = "postgresql://ci:ci@127.0.0.1:5432/pin_go_twilio_sms_recovery";
if (process.env.DATABASE_URL !== expected || process.env.TWILIO_RECOVERY_DISPOSABLE_DB !== "1") {
  throw new Error("DISPOSABLE_TWILIO_RECOVERY_DATABASE_REQUIRED");
}
const prisma = new PrismaClient();
const db: SmsRecoveryDatabase = {
  $transaction: work => prisma.$transaction(tx => work(tx), { maxWait: 20_000, timeout: 20_000 }),
};
const first = new Date("2026-10-02T16:00:04.000Z");
const due = new Date("2026-10-02T16:30:04.000Z");
const arrival = new Date("2026-10-02T20:00:00.000Z");
const departure = new Date("2026-10-04T15:00:00.000Z");
const settings = { delayMs: 1_800_000, minimumSpacingMs: 900_000 };
const freshSid = () => "SM" + randomBytes(16).toString("hex");
const ready: SmsRecoveryReadinessReader = async () => ({
  eligible: true, contentValidUntil: arrival, nextScheduledMessage: null,
});
async function fixture() {
  const suffix = randomUUID();
  const org = await prisma.organization.create({ data: { name: "Offline SMS recovery " + suffix } });
  const p = await prisma.property.create({ data: { organizationId: org.id, name: "Offline property" } });
  const r = await prisma.reservation.create({ data: {
    propertyId: p.id, guestName: "Offline Guest", guestPhone: "+17875550101",
    checkIn: arrival, checkOut: departure,
  } });
  const m = await prisma.messageLog.create({ data: {
    organizationId: org.id, propertyId: p.id, reservationId: r.id,
    channel: "sms", provider: "twilio", to: "+17875550101", body: "Offline arrival instructions",
    providerMessageId: freshSid(), status: "SENT", communicationType: "PRECHECKIN",
    providerDeliveryStatus: "UNDELIVERED", providerErrorCode: "30005", providerStatusUpdatedAt: first,
  } });
  const scope: SmsRecoveryScope = {
    messageLogId: m.id, organizationId: org.id, propertyId: p.id, reservationId: r.id,
    originalProviderMessageId: m.providerMessageId!,
  };
  return { scope, m, r, p, org };
}
async function journal(s: SmsRecoveryScope) {
  return prisma.twilioSmsRecovery.findUniqueOrThrow({ where: { messageLogId: s.messageLogId } });
}
async function registered() {
  const f = await fixture();
  await registerTwilioSmsRecovery(db, f.scope, settings, () => first);
  return f;
}
async function claimed() {
  const f = await registered();
  const c = await claimTwilioSmsRecovery(db, f.scope, ready, () => due);
  assert.equal(c.kind, "CLAIMED");
  if (c.kind !== "CLAIMED") throw new Error("FIXTURE_NOT_CLAIMED");
  return { ...f, c };
}

test("durable single-retry journal on disposable PostgreSQL", async t => {
  t.after(async () => { await prisma.$disconnect(); });
  // Workflow applies actual migrations into a brand-new database, not db push.
  assert.equal(await prisma.twilioSmsRecovery.count(), 0);

  await t.test("concurrent failure registration preserves one anchored failure and zero retries", async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      registerTwilioSmsRecovery(db, f.scope, settings, () => first)));
    assert.equal(results.filter(r => r.created).length, 1);
    const j = await journal(f.scope);
    assert.equal(j.firstFailureAt.toISOString(), first.toISOString());
    assert.equal(j.retryNotBefore.toISOString(), due.toISOString());
    assert.equal(j.retriesUsed, 0);
    await registerTwilioSmsRecovery(db, f.scope, { delayMs: 3_600_000, minimumSpacingMs: 60_000 }, () => due);
    assert.deepEqual(await journal(f.scope), j, "callback replay cannot change anchors/settings");
    assert.doesNotMatch(JSON.stringify(j), /17875550101|Offline arrival instructions/);
  });

  for (const mutation of [
    { providerDeliveryStatus: "SENT", providerErrorCode: null },
    { providerErrorCode: "30007" }, { providerStatusUpdatedAt: null }, { retryCount: 1 },
    { communicationType: "CLEANING_CONFIRMATION" }, { to: "+17875550999" },
  ]) {
    await t.test(`registration rejects unqualified persisted evidence ${JSON.stringify(mutation)}`, async () => {
      const f = await fixture();
      await prisma.messageLog.update({ where: { id: f.m.id }, data: mutation });
      await assert.rejects(registerTwilioSmsRecovery(db, f.scope, settings, () => first));
      assert.equal(await prisma.twilioSmsRecovery.count({ where: { messageLogId: f.m.id } }), 0);
    });
  }
  await t.test("another organization cannot register or claim the message", async () => {
    const f = await fixture();
    const foreign = { ...f.scope, organizationId: "foreign-org" };
    await assert.rejects(registerTwilioSmsRecovery(db, foreign, settings, () => first), /SOURCE_SCOPE_MISMATCH/);
    await registerTwilioSmsRecovery(db, f.scope, settings, () => first);
    await assert.rejects(claimTwilioSmsRecovery(db, foreign, ready, () => due), /JOURNAL_SCOPE_MISMATCH/);
    assert.equal((await journal(f.scope)).retriesUsed, 0);
  });
  await t.test("ambiguous MessageLog SID mappings are not silently selected", async () => {
    const f = await fixture();
    await prisma.messageLog.create({ data: { ...f.m, id: "duplicate-" + randomUUID() } });
    await assert.rejects(registerTwilioSmsRecovery(db, f.scope, settings, () => first), /AMBIGUOUS_PROVIDER_SID/);
  });
  await t.test("the due boundary is enforced, then eight workers obtain exactly one claim", async () => {
    const f = await registered();
    const early = await claimTwilioSmsRecovery(db, f.scope, ready, () => new Date(due.getTime() - 1));
    assert.equal(early.kind, "DECISION");
    if (early.kind === "DECISION") assert.equal(early.decision.kind, "WAIT_FOR_RETRY");
    assert.equal((await journal(f.scope)).retriesUsed, 0);
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      claimTwilioSmsRecovery(db, f.scope, ready, () => due)));
    assert.equal(results.filter(r => r.kind === "CLAIMED").length, 1);
    assert.equal((await journal(f.scope)).retriesUsed, 1);
    // A fresh Prisma client simulates an executor restart; the budget remains consumed.
    const other = new PrismaClient();
    try {
      const restarted: SmsRecoveryDatabase = { $transaction: work => other.$transaction(tx => work(tx)) };
      assert.equal((await claimTwilioSmsRecovery(restarted, f.scope, ready, () => due)).kind, "HELD");
    } finally { await other.$disconnect(); }
  });
  await t.test("submission retains the original SID and is idempotent, never DELIVERED", async () => {
    const f = await claimed();
    const nextSid = freshSid();
    await recordTwilioSmsRetrySubmission(db, f.scope, f.c.claimToken, nextSid, () => due);
    assert.deepEqual(await recordTwilioSmsRetrySubmission(db, f.scope, f.c.claimToken, nextSid, () => due),
      { state: "SUBMITTED", changed: false });
    assert.equal((await journal(f.scope)).retryProviderMessageId, nextSid);
    assert.equal((await journal(f.scope)).retriesUsed, 1);
    assert.deepEqual(await prisma.messageLog.findUnique({ where: { id: f.m.id } }), f.m);
    assert.equal((await registerTwilioSmsRecovery(db, f.scope, settings, () => due)).created, false);
    await assert.rejects(recordTwilioSmsRetrySubmission(db, f.scope, f.c.claimToken, freshSid(), () => due),
      /SUBMISSION_CHANGED/);
  });
  await t.test("unknown outcome consumes budget; a late known response may reconcile without resending", async () => {
    const f = await claimed();
    await recordTwilioSmsRetrySubmission(db, f.scope, f.c.claimToken, null, () => due);
    assert.equal((await journal(f.scope)).state, "OUTCOME_UNKNOWN");
    assert.equal((await claimTwilioSmsRecovery(db, f.scope, ready, () => due)).kind, "HELD");
    await recordTwilioSmsRetrySubmission(db, f.scope, f.c.claimToken, freshSid(), () => due);
    assert.equal((await journal(f.scope)).state, "SUBMITTED");
    assert.equal((await journal(f.scope)).retriesUsed, 1);
  });
  await t.test("wrong claim or reused SID cannot replace the attempt", async () => {
    const f = await claimed();
    await assert.rejects(recordTwilioSmsRetrySubmission(db, f.scope, randomUUID(), freshSid()), /CLAIM_MISMATCH/);
    await assert.rejects(recordTwilioSmsRetrySubmission(db, f.scope, f.c.claimToken, f.scope.originalProviderMessageId),
      /INVALID_SUBMISSION/);
    const other = await fixture();
    await assert.rejects(recordTwilioSmsRetrySubmission(db, f.scope, f.c.claimToken, other.scope.originalProviderMessageId),
      /PROVIDER_SID_ALREADY_USED/);
    assert.equal((await journal(f.scope)).state, "CLAIMED");
  });
  await t.test("two logical retries cannot acquire the same provider SID", async () => {
    const a = await claimed(), b = await claimed(), nextSid = freshSid();
    const results = await Promise.allSettled([
      recordTwilioSmsRetrySubmission(db, a.scope, a.c.claimToken, nextSid, () => due),
      recordTwilioSmsRetrySubmission(db, b.scope, b.c.claimToken, nextSid, () => due),
    ]);
    assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
    assert.equal(await prisma.twilioSmsRecovery.count({ where: { retryProviderMessageId: nextSid } }), 1);
  });
  for (const mutation of [{ body: "Changed instructions" }, { to: "+17875550999" }, { retryCount: 1 }]) {
    await t.test(`changed send evidence cannot claim stale content ${JSON.stringify(mutation)}`, async () => {
      const f = await registered();
      await prisma.messageLog.update({ where: { id: f.m.id }, data: mutation });
      const result = await claimTwilioSmsRecovery(db, f.scope, ready, () => due);
      assert.equal(result.kind, "DECISION");
      if (result.kind === "DECISION") assert.equal(result.decision.reason, "RECIPIENT_OR_CONTENT_CHANGED");
      assert.equal((await journal(f.scope)).retriesUsed, 0);
    });
  }
  await t.test("current eligibility rejection does not spend a retry", async () => {
    const f = await registered();
    await claimTwilioSmsRecovery(db, f.scope, async () => ({
      eligible: false, contentValidUntil: arrival, nextScheduledMessage: null,
    }), () => due);
    assert.equal((await journal(f.scope)).state, "REVIEW");
    assert.equal((await journal(f.scope)).retriesUsed, 0);
  });
  await t.test("cancellation and an expired precheckin are not replayed", async () => {
    const f = await registered();
    await prisma.reservation.update({ where: { id: f.r.id }, data: { status: "CANCELLED" } });
    await claimTwilioSmsRecovery(db, f.scope, ready, () => due);
    assert.equal((await journal(f.scope)).state, "EXPIRED");
    const g = await registered();
    await claimTwilioSmsRecovery(db, g.scope, ready, () => arrival);
    assert.equal((await journal(g.scope)).state, "EXPIRED");
  });
  await t.test("clock is re-read after readiness work and cannot authorize an expired claim", async () => {
    const f = await registered();
    let current = due;
    await claimTwilioSmsRecovery(db, f.scope, async () => {
      current = arrival;
      return { eligible: true, contentValidUntil: arrival, nextScheduledMessage: null };
    }, () => current);
    assert.equal((await journal(f.scope)).state, "EXPIRED");
    assert.equal((await journal(f.scope)).retriesUsed, 0);
  });
  await t.test("yield is durable and a separate 2pm access message has its own budget", async () => {
    const f = await registered();
    const nextKey = "access-" + randomUUID();
    const scheduledAt = new Date("2026-10-02T18:00:00.000Z");
    const readNext: SmsRecoveryReadinessReader = async () => ({
      eligible: true, contentValidUntil: arrival,
      nextScheduledMessage: { messageKey: nextKey, organizationId: f.org.id,
        propertyId: f.p.id, reservationId: f.r.id, scheduledAt },
    });
    const result = await claimTwilioSmsRecovery(db, f.scope, readNext, () => new Date("2026-10-02T17:50:00Z"));
    assert.equal(result.kind, "DECISION");
    if (result.kind === "DECISION") {
      assert.equal(result.decision.kind, "WAIT_FOR_NEXT_MESSAGE");
      assert.equal(result.decision.blockOtherScheduledMessages, false);
    }
    const j = await journal(f.scope);
    assert.equal(j.state, "YIELDED"); assert.equal(j.nextMessageKey, nextKey);
    assert.equal(j.nextMessageAt?.toISOString(), scheduledAt.toISOString());
    assert.equal((await claimTwilioSmsRecovery(db, f.scope, ready, () => scheduledAt)).kind, "HELD");
    const later = await prisma.messageLog.create({ data: {
      ...f.m, id: nextKey, communicationType: "GUEST_ACCESS_PASSCODE", body: "Offline access instructions",
      providerMessageId: freshSid(), providerStatusUpdatedAt: scheduledAt,
    } });
    const nextScope = { ...f.scope, messageLogId: later.id, originalProviderMessageId: later.providerMessageId! };
    await registerTwilioSmsRecovery(db, nextScope, settings, () => scheduledAt);
    const laterResult = await claimTwilioSmsRecovery(db, nextScope, ready,
      () => new Date(scheduledAt.getTime() + settings.delayMs));
    assert.equal(laterResult.kind, "CLAIMED");
    assert.equal((await journal(f.scope)).retriesUsed, 0);
    assert.equal((await journal(nextScope)).retriesUsed, 1);
  });
  await t.test("a pre-existing resolved host issue is not reopened or sent again", async () => {
    const f = await registered();
    await prisma.operationalIssue.create({ data: {
      operationalKey: smsFailureOperationalKey(f.m.id, f.scope.originalProviderMessageId),
      issueCode: "GUEST_SMS_UNKNOWN_DESTINATION", title: "Offline resolution", issue: "Offline test",
      engine: "COMMUNICATIONS", severity: "WARNING", workflowState: "RESOLVED", visibility: "HOST",
      responsibleActor: "NONE", actionRequired: false, canAutoResolve: false, autoResolveStatus: "NOT_SUPPORTED",
      sourceType: "MANUAL", actionTarget: "RESERVATION", organizationId: f.org.id, propertyId: f.p.id,
      reservationId: f.r.id, resolutionCode: "TEST_RESOLVED", resolutionSummary: "Offline handled",
      resolutionType: "MANUAL", resolvedBy: "HOST", resolvedAt: first,
    } });
    const result = await claimTwilioSmsRecovery(db, f.scope, ready, () => due);
    assert.equal(result.kind, "DECISION");
    if (result.kind === "DECISION") assert.equal(result.decision.reason, "EXISTING_ISSUE_RESOLVED");
    assert.equal((await journal(f.scope)).retriesUsed, 0);
  });
  await t.test("transaction failure rolls back registration and claim instead of consuming phantom budget", async () => {
    const rollback: SmsRecoveryDatabase = {
      $transaction: work => prisma.$transaction(async tx => { await work(tx); throw new Error("TEST_ROLLBACK"); }),
    };
    const f = await fixture();
    await assert.rejects(registerTwilioSmsRecovery(rollback, f.scope, settings, () => first), /TEST_ROLLBACK/);
    assert.equal(await prisma.twilioSmsRecovery.count({ where: { messageLogId: f.m.id } }), 0);
    await registerTwilioSmsRecovery(db, f.scope, settings, () => first);
    await assert.rejects(claimTwilioSmsRecovery(rollback, f.scope, ready, () => due), /TEST_ROLLBACK/);
    assert.equal((await journal(f.scope)).retriesUsed, 0);
    assert.equal((await claimTwilioSmsRecovery(db, f.scope, ready, () => due)).kind, "CLAIMED");
  });
  await t.test("database constraints reject more than one retry and an unclaimed submission", async () => {
    const f = await registered();
    await assert.rejects(prisma.$executeRawUnsafe(
      'UPDATE "TwilioSmsRecovery" SET "retriesUsed"=2 WHERE "messageLogId"=$1', f.m.id));
    await assert.rejects(prisma.$executeRawUnsafe(
      `UPDATE "TwilioSmsRecovery" SET "state"='SUBMITTED' WHERE "messageLogId"=$1`, f.m.id));
    assert.equal((await journal(f.scope)).retriesUsed, 0);
  });
});
