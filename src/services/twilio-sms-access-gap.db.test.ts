import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { persistTwilioSmsAccessGap, twilioSmsAccessGapKey } from "./twilio-sms-access-gap.service.js";
import { registerTwilioSmsRecovery, claimTwilioSmsRecovery, type SmsRecoveryDatabase } from "./twilio-sms-recovery.store.js";

if (process.env.DATABASE_URL !== "postgresql://ci:ci@127.0.0.1:5432/pin_go_twilio_sms_recovery" ||
    process.env.TWILIO_RECOVERY_DISPOSABLE_DB !== "1") throw new Error("DISPOSABLE_TWILIO_RECOVERY_DATABASE_REQUIRED");
const prisma = new PrismaClient();
const sid = () => "SM" + randomBytes(16).toString("hex");
const first = new Date("2026-10-02T18:00:10Z"), due = new Date("2026-10-02T18:30:10Z");
const arrival = new Date("2026-10-02T20:00:00Z"), departure = new Date("2026-10-04T15:00:00Z");
let lockCounter = 910_000_000;
async function fixture() {
  const org = await prisma.organization.create({ data: { name: "Offline access-gap organization" } });
  const property = await prisma.property.create({ data: { organizationId: org.id, name: "Offline property" } });
  const reservation = await prisma.reservation.create({ data: {
    propertyId: property.id, guestName: "Offline guest", guestPhone: "+17875550101", guestEmail: null,
    checkIn: arrival, checkOut: departure,
  } });
  const lock = await prisma.lock.create({ data: { propertyId: property.id, ttlockLockId: lockCounter++ } });
  const grant = await prisma.accessGrant.create({ data: { lockId: lock.id, reservationId: reservation.id,
    method: "PASSCODE_TIMEBOUND", status: "ACTIVE", startsAt: arrival, endsAt: departure } });
  const message = await prisma.messageLog.create({ data: {
    organizationId: org.id, propertyId: property.id, reservationId: reservation.id, accessGrantId: grant.id,
    provider: "twilio", channel: "sms", communicationType: "GUEST_ACCESS_PASSCODE", status: "SENT",
    to: "+17875550101", body: "PRIVATE_FIXTURE_BODY", providerMessageId: sid(),
    providerDeliveryStatus: "UNDELIVERED", providerErrorCode: "30005", providerStatusUpdatedAt: first,
    createdAt: first,
  } });
  const scope = { messageLogId: message.id, organizationId: org.id, propertyId: property.id,
    reservationId: reservation.id, originalProviderMessageId: message.providerMessageId! };
  return { org, property, reservation, lock, grant, message, scope };
}
const store: SmsRecoveryDatabase = { $transaction: work => prisma.$transaction(tx => work(tx)) };

test("access communication gap persists atomically without suppressing retry", async t => {
  t.after(async () => { await prisma.$disconnect(); });
  await t.test("eight projections create one critical issue and one transition, without changing access/message", async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => persistTwilioSmsAccessGap(prisma, f.scope, () => first)));
    assert.equal(results.filter(r => r.kind === "CREATED").length, 1);
    assert.equal(results.filter(r => r.kind === "PRESERVED").length, 7);
    const issue = await prisma.operationalIssue.findUniqueOrThrow({ where: { operationalKey: twilioSmsAccessGapKey(f.scope) } });
    assert.equal(issue.workflowState, "ACTION_REQUIRED"); assert.equal(issue.severity, "CRITICAL");
    assert.equal(issue.visibility, "HOST"); assert.equal(issue.responsibleActor, "HOST");
    assert.equal(issue.organizationId, f.org.id); assert.equal(issue.reservationId, f.reservation.id);
    assert.equal(await prisma.operationalIssueTransition.count({ where: { issueId: issue.id } }), 1);
    assert.doesNotMatch(JSON.stringify(issue), /17875550101|PRIVATE_FIXTURE_BODY/);
    assert.deepEqual(await prisma.accessGrant.findUnique({ where: { id: f.grant.id } }), f.grant);
    assert.deepEqual(await prisma.messageLog.findUnique({ where: { id: f.message.id } }), f.message);
    assert.deepEqual(await prisma.reservation.findUnique({ where: { id: f.reservation.id } }), f.reservation);
  });
  await t.test("host attention and the one delayed retry coexist", async () => {
    const f = await fixture();
    await registerTwilioSmsRecovery(store, f.scope, { delayMs: 1_800_000, minimumSpacingMs: 900_000 }, () => first);
    assert.equal((await persistTwilioSmsAccessGap(prisma, f.scope, () => first)).kind, "CREATED");
    assert.equal((await prisma.twilioSmsRecovery.findUniqueOrThrow({ where: { messageLogId: f.message.id } })).retriesUsed, 0);
    const claim = await claimTwilioSmsRecovery(store, f.scope, async () => ({
      eligible: true, contentValidUntil: departure, nextScheduledMessage: null,
    }), () => due);
    assert.equal(claim.kind, "CLAIMED");
    if (claim.kind !== "CLAIMED") throw new Error("EXPECTED_CLAIM");
    assert.equal(claim.blockOtherScheduledMessages, false);
    assert.equal((await persistTwilioSmsAccessGap(prisma, f.scope, () => due)).kind, "PRESERVED");
    assert.equal((await prisma.twilioSmsRecovery.findUniqueOrThrow({ where: { messageLogId: f.message.id } })).retriesUsed, 1);
  });
  await t.test("resolved action is not reopened by duplicate evidence", async () => {
    const f = await fixture();
    const result = await persistTwilioSmsAccessGap(prisma, f.scope, () => first);
    await prisma.operationalIssue.update({ where: { id: result.issueId! }, data: { workflowState: "RESOLVED" } });
    assert.equal((await persistTwilioSmsAccessGap(prisma, f.scope, () => due)).kind, "PRESERVED");
    assert.equal((await prisma.operationalIssue.findUniqueOrThrow({ where: { id: result.issueId! } })).workflowState, "RESOLVED");
  });
  for (const mutation of [
    { communicationType: "PRECHECKIN" }, { communicationType: "CLEANING_CONFIRMATION" },
    { providerDeliveryStatus: "SENT" }, { providerDeliveryStatus: "DELIVERED", providerErrorCode: null },
    { providerErrorCode: "30007" }, { to: "+17875550999" }, { accessGrantId: null },
  ]) {
    await t.test(`does not fabricate an access gap for ${JSON.stringify(mutation)}`, async () => {
      const f = await fixture();
      await prisma.messageLog.update({ where: { id: f.message.id }, data: mutation });
      assert.equal((await persistTwilioSmsAccessGap(prisma, f.scope, () => due)).kind, "NO_ACTION");
      assert.equal(await prisma.operationalIssue.count({ where: { operationalKey: twilioSmsAccessGapKey(f.scope) } }), 0);
    });
  }
  await t.test("an email address is not treated as delivery proof or email missing", async () => {
    const f = await fixture();
    await prisma.reservation.update({ where: { id: f.reservation.id }, data: { guestEmail: "offline@example.invalid" } });
    const result = await persistTwilioSmsAccessGap(prisma, f.scope, () => due);
    assert.equal(result.reason, "EMAIL_PRESENT_REQUIRES_SEPARATE_DELIVERY_EVIDENCE");
  });
  await t.test("cancelled stay, revoked access and checkout do not create stale host work", async () => {
    const f = await fixture();
    await prisma.reservation.update({ where: { id: f.reservation.id }, data: { status: "CANCELLED" } });
    assert.equal((await persistTwilioSmsAccessGap(prisma, f.scope, () => due)).kind, "NO_ACTION");
    const g = await fixture();
    await prisma.accessGrant.update({ where: { id: g.grant.id }, data: { status: "REVOKED" } });
    assert.equal((await persistTwilioSmsAccessGap(prisma, g.scope, () => due)).kind, "NO_ACTION");
    const h = await fixture();
    assert.equal((await persistTwilioSmsAccessGap(prisma, h.scope, () => departure)).kind, "NO_ACTION");
  });
  await t.test("foreign organization and changed SID cannot create an action", async () => {
    const f = await fixture();
    await assert.rejects(persistTwilioSmsAccessGap(prisma, { ...f.scope, organizationId: "foreign" }, () => due), /SOURCE_SCOPE_MISMATCH/);
    await assert.rejects(persistTwilioSmsAccessGap(prisma, { ...f.scope, originalProviderMessageId: sid() }, () => due), /SOURCE_ATTEMPT_CHANGED/);
  });
  await t.test("missing timestamp or future clock evidence requires review", async () => {
    const f = await fixture();
    await prisma.messageLog.update({ where: { id: f.message.id }, data: { providerStatusUpdatedAt: null } });
    await assert.rejects(persistTwilioSmsAccessGap(prisma, f.scope, () => due), /FAILURE_TIME_INVALID/);
    const g = await fixture();
    await assert.rejects(persistTwilioSmsAccessGap(prisma, g.scope, () => new Date(first.getTime()-1)), /FAILURE_TIME_INVALID/);
  });
  await t.test("rollback removes both issue and its transition", async () => {
    const f = await fixture();
    const rollback = { $transaction: (work: (tx: any) => Promise<unknown>) => prisma.$transaction(async tx => {
      await work(tx); throw new Error("TEST_ROLLBACK");
    }) } as unknown as Pick<PrismaClient, "$transaction">;
    await assert.rejects(persistTwilioSmsAccessGap(rollback, f.scope, () => due), /TEST_ROLLBACK/);
    assert.equal(await prisma.operationalIssue.count({ where: { operationalKey: twilioSmsAccessGapKey(f.scope) } }), 0);
    assert.equal(await prisma.operationalIssueTransition.count({ where: { operationalKey: twilioSmsAccessGapKey(f.scope) } }), 0);
  });
});
