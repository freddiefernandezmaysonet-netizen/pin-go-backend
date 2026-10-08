import { materializeCleaningWorkSnapshot } from "./cleaning-work-snapshot.service.js";
import { createCleaningWorkSnapshotStore } from "./cleaning-work-snapshot.prisma.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { processCleaningIssueRecoveries } from "./cleaning-issue-recovery.service.js";
import { extendCleanerAccess } from "./cleaner-access-extension.service.js";
import { readCleanerAccessWindow } from "./cleaner-access-window.service.js";
import { assessLatestCleaningIssue } from "./cleaning-issue-assessment.service.js";
import { reconcilePropertyCleanerAccess } from "./cleaner-access-property-reconcile.service.js";
import { offerBackupForIncompleteCleaning, acceptCleaningOffer, withdrawCleaning } from "./cleaning-reassignment.service.js";
import { ensureCleanerNfcAccessForConfirmedCleaning } from "./cleaner-access-autopilot.service.js";
import { expireNfcAssignments } from "./nfc-expire.service.js";
import { confirmCleaningStart } from "./cleaning-work-start.prisma.js";
import { acceptCleaningTimingConsent } from "./cleaning-timing-consent.prisma.js";
import { recordDeferredCleaningOfferAttention } from "./cleaning-offer-hours.service.js";

process.env.PIN_AI_CONNECT_DEBIT_ENABLED = "true";
process.env.PIN_AI_PROPERTY_ACTIVATION_ENABLED = "true";
process.env.PIN_AI_ALL_ORGANIZATIONS_ENABLED = "true";
process.env.PIN_AI_RESERVATION_FEE_RECORDING_ENABLED = "true";
const databaseUrl = process.env.CLEANER_ACCOUNT_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/cleaner_account_test") throw new Error("Use isolated loopback cleaner_account_test only");
}
test("cleaning recovery persists real SQL transitions with injected hardware only", { skip: !databaseUrl }, async t => {
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
  const fixtureIds: string[] = [];
  let lockSequence = 10000;
  t.after(async () => {
    for (const id of fixtureIds) {
      await db.cleaningAccessExtension.deleteMany({ where: { organizationId: id } });
      await db.cleaningWorkIssueReport.deleteMany({ where: { work: { propertyId: id } } });
      await db.cleaningWork.deleteMany({ where: { propertyId: id } });
      await db.cleaningConfirmation.deleteMany({ where: { propertyId: id } });
      await db.operationalIssue.deleteMany({ where: { organizationId: id } });
      await db.cleaningHostAttentionNotice.deleteMany({ where: { cleaningWorkId: { startsWith: id } } });
      await db.reservation.deleteMany({ where: { propertyId: id } });
      await db.nfcCard.deleteMany({ where: { propertyId: id } });
      await db.lock.deleteMany({ where: { propertyId: id } });
      await db.property.delete({ where: { id } });
      await db.staffMember.deleteMany({ where: { organizationId: id } });
      await db.organization.delete({ where: { id } });
    }
    await db.$disconnect();
  });
  async function fixture(now = new Date("2026-10-07T19:00:00Z")) {
    const id = `recovery-${randomUUID()}`; fixtureIds.push(id);
    const start = new Date(now.getTime() - 10 * 60000), end = new Date(start.getTime() + 30 * 60000);
    const lockId = ++lockSequence;
    await db.organization.create({ data: { id, name: "Synthetic recovery org", pinAIEnabled: true, pinAIRevision: 1, stripeConnectAccountId: `acct_${id}` } });
    await db.property.create({ data: { id, organizationId: id, name: "Synthetic recovery", pinAIEnabled: true, pinAIRevision: 1, pinAITermsVersion: "pin-ai-connect-usd-1-reservation-v1", pinAITermsAcceptedAt: start, pinAITermsAcceptedBy: "synthetic-host", status: "ACTIVE", cleaningNfcEnabled: true, cleaningStartOffsetMinutes: 0 } });
    await db.lock.create({ data: { propertyId: id, ttlockLockId: lockId } });
    await db.staffMember.create({ data: { id, organizationId: id, fullName: "Synthetic cleaner", phoneE164: "+15555550101", ttlockCardRef: "own-card" } });
    await db.propertyStaff.create({ data: { propertyId: id, staffMemberId: id, role: "PRIMARY", cleaningDurationCommitmentMinutes: 30 } });
    await db.reservation.create({ data: { id, propertyId: id, source: "INTERNAL_DEMO_DIRECT_BOOKING", guestName: "Synthetic", status: "ACTIVE", checkIn: new Date(start.getTime() - 86400000), checkOut: start } });
    await db.cleaningConfirmation.create({ data: { id, token: randomUUID(), reservationId: id, propertyId: id, staffMemberId: id, status: "CONFIRMED" } });
    const work = await db.cleaningWork.create({ data: { id, reservationId: id, propertyId: id, staffMemberId: id, confirmationId: id,
      scheduledStartAt: start, durationCommitmentMinutes: 30, startConfirmationGraceMinutes: 30, followupGraceMinutes: 15,
      timingConsentAcceptedAt: start, startConfirmedAt: start } });
    await db.staffAssignment.create({ data: { id, reservationId: id, staffMemberId: id, startsAt: start, endsAt: end, status: "ACTIVE" } });
    const card = await db.nfcCard.create({ data: { propertyId: id, label: "own-card", ttlockCardId: 123, status: "ASSIGNED" } });
    const grant = await db.nfcAssignment.create({ data: { reservationId: id, nfcCardId: card.id, role: "CLEANING", status: "ACTIVE", startsAt: start, endsAt: end, retryCount: 1 } });
    await db.cleanerNfcProgrammingAttempt.create({ data: { nfcAssignmentId: grant.id, confirmationId: id, attemptNumber: 1,
      organizationId: id, ttlockLockId: lockId, ttlockCardId: 123, startsAt: start, endsAt: end, state: "ACKNOWLEDGED", acknowledgedAt: start } });
    await db.cleaningRecoveryPolicy.create({ data: { propertyId: id, revision: 1, maxDelayMinutes: 30, maxAccessExtensionMinutes: 60, arrivalSafetyMarginMinutes: 0, updatedByUserId: "synthetic-host" } });
    const report = await db.cleaningWorkIssueReport.create({ data: { cleaningWorkId: id, requestId: randomUUID(), kind: "MORE_TIME", reason: "Synthetic extra work", reportedAt: now,
      estimatedAt: new Date(now.getTime() + 30 * 60000) } });
    const commands: any[] = [];
    const dependencies = { now: () => now, changeCardPeriod: async (args: any) => { commands.push(args); return {}; } };
    return { id, now, start, end, lockId, work, report, grant, commands, dependencies, scope: { reportId: report.id, organizationId: id } };
  }
  await t.test("acknowledged extension is unique, preserves commitment and survives occupancy reconciliation", async () => {
    const f = await fixture();
    assert.equal((await extendCleanerAccess(db, f.scope, f.dependencies)).state, "APPLIED");
    assert.equal((await extendCleanerAccess(db, f.scope, f.dependencies)).replayed, true);
    assert.equal(f.commands.length, 1); assert.equal(f.commands[0].lockId, f.lockId); assert.equal(f.commands[0].cardId, 123);
    const proposed = new Date(f.now.getTime() + 31 * 60000);
    const grant = await db.nfcAssignment.findUniqueOrThrow({ where: { id: f.grant.id } });
    assert.deepEqual(grant.endsAt, proposed);
    const work = await db.cleaningWork.findUniqueOrThrow({ where: { id: f.id } });
    assert.equal(work.durationCommitmentMinutes, 30); assert.equal(work.completionConfirmedAt, null); assert.equal(work.cancelledAt, null);
    const reservation = await db.reservation.findUniqueOrThrow({ where: { id: f.id }, include: { property: true } });
    assert.deepEqual((await readCleanerAccessWindow(db, reservation)).endsAt, proposed);
    await reconcilePropertyCleanerAccess(db, f.id, { now: () => f.now, changeCardPeriod: async () => { throw new Error("Must retain approved extension"); } });
    const assessment = await db.$transaction(tx => assessLatestCleaningIssue(tx, work, f.now));
    assert.equal(assessment?.decision, "ACCESS_EXTENDED"); assert.equal(assessment?.accessChanged, true);
    // An old expiry pass must see the new end rather than retire this grant.
    await expireNfcAssignments(db, new Date(f.end.getTime() + 1000));
    assert.equal((await db.nfcAssignment.findUniqueOrThrow({ where: { id: f.grant.id } })).status, "ACTIVE");
  });
  await t.test("a new arrival or zero host limit prevents every hardware command", async () => {
    for (const reason of ["arrival", "limit"]) {
      const f = await fixture();
      if (reason === "arrival") await db.reservation.create({ data: { propertyId: f.id, guestName: "Synthetic next", status: "ACTIVE", checkIn: new Date(f.now.getTime() + 120 * 60000), checkOut: new Date(f.now.getTime() + 86400000) } });
      else await db.cleaningRecoveryPolicy.update({ where: { propertyId: f.id }, data: { maxAccessExtensionMinutes: 0, revision: 2 } });
      await assert.rejects(extendCleanerAccess(db, f.scope, f.dependencies), /POLICY_NOT_ELIGIBLE/);
      assert.equal(f.commands.length, 0);
    }
  });
  await t.test("ambiguous gateway response is durable and never blindly retried", async () => {
    const f = await fixture(); let calls = 0;
    const deps = { ...f.dependencies, changeCardPeriod: async () => { calls++; throw new Error("Synthetic response lost"); } };
    assert.equal((await extendCleanerAccess(db, f.scope, deps)).state, "UNCERTAIN");
    assert.equal((await extendCleanerAccess(db, f.scope, deps)).state, "UNCERTAIN");
    assert.equal(calls, 1);
    const grant = await db.nfcAssignment.findUniqueOrThrow({ where: { id: f.grant.id } });
    assert.equal(grant.status, "PROVISIONING"); assert.equal(grant.lastError, "CLEANER_EXTENSION_UNCERTAIN"); assert.deepEqual(grant.endsAt, f.end);
  });
  await t.test("subsequent reports cannot accumulate extensions beyond the original host cap", async () => {
    const f = await fixture(); await extendCleanerAccess(db, f.scope, f.dependencies);
    const report = await db.cleaningWorkIssueReport.create({ data: { cleaningWorkId: f.id, requestId: randomUUID(), kind: "MORE_TIME", reason: "Synthetic further work",
      reportedAt: new Date(f.now.getTime() + 1000), estimatedAt: new Date(f.end.getTime() + 61 * 60000) } });
    await assert.rejects(extendCleanerAccess(db, { reportId: report.id, organizationId: f.id }, { ...f.dependencies, now: () => new Date(f.now.getTime() + 2000) }), /POLICY_NOT_ELIGIBLE/);
    assert.equal(f.commands.length, 1);
  });
  await t.test("an interrupted command is escalated without a new hardware attempt", async () => {
    const f = await fixture();
    await db.cleaningAccessExtension.create({ data: { reportId: f.report.id, organizationId: f.id, propertyId: f.id,
      reservationId: f.id, cleaningWorkId: f.id, confirmationId: f.id, nfcAssignmentId: f.grant.id, nfcCardId: f.grant.nfcCardId,
      ttlockLockId: f.lockId, ttlockCardId: 123, policyRevision: 1, startsAt: f.start, previousEndsAt: f.end,
      proposedEndsAt: new Date(f.end.getTime() + 10 * 60000), state: "SENDING", updatedAt: new Date(f.now.getTime() - 120000) } });
    await db.nfcAssignment.update({ where: { id: f.grant.id }, data: { status: "PROVISIONING", lastError: "CLEANER_EXTENSION_PENDING" } });
    assert.equal((await extendCleanerAccess(db, f.scope, f.dependencies)).state, "UNCERTAIN");
    assert.equal(f.commands.length, 0);
  });
  await t.test("incomplete recovery offers a distinct backup; acceptance and own NFC remain explicit", async () => {
    const f = await fixture();
    await extendCleanerAccess(db, f.scope, f.dependencies);
    const incompleteAt = new Date(f.now.getTime() + 1000);
    const incomplete = await db.cleaningWorkIssueReport.create({ data: { cleaningWorkId: f.id, requestId: randomUUID(), kind: "INCOMPLETE",
      reason: "Synthetic handoff", reportedAt: incompleteAt } });
    const backupId = `${f.id}-backup`;
    await db.staffMember.create({ data: { id: backupId, organizationId: f.id, fullName: "Synthetic backup", phoneE164: "+15555550102", ttlockCardRef: "backup-card" } });
    await db.propertyStaff.create({ data: { propertyId: f.id, staffMemberId: backupId, role: "BACKUP", backupOrder: 1, cleaningDurationCommitmentMinutes: 15 } });
    const card = await db.nfcCard.create({ data: { propertyId: f.id, label: "backup-card", ttlockCardId: 456 } });
    const result = await offerBackupForIncompleteCleaning(db, { reportId: incomplete.id, organizationId: f.id, confirmationId: f.id, staffMemberId: f.id }, incompleteAt);
    assert.equal(result.recovery, "BACKUP_OFFER_PENDING");
    const offer = await db.cleaningConfirmation.findUniqueOrThrow({ where: { id: result.nextConfirmationId! } });
    assert.equal(offer.status, "PENDING"); assert.equal(offer.staffMemberId, backupId);
    assert.equal(await db.nfcAssignment.count({ where: { nfcCardId: card.id } }), 0);
    const work = await db.cleaningWork.findUniqueOrThrow({ where: { id: f.id } });
    assert.ok(work.supersededAt); assert.equal(work.cancelledAt, null); assert.equal(work.completionConfirmedAt, null); assert.equal(work.durationCommitmentMinutes, 30);
    await acceptCleaningOffer(db, { confirmationId: offer.id, staffMemberId: backupId, organizationId: f.id }, incompleteAt);
    const backupWork = await db.cleaningWork.findFirstOrThrow({ where: { confirmationId: offer.id } });
    assert.deepEqual(backupWork.scheduledStartAt, incompleteAt);
    assert.equal(backupWork.durationCommitmentMinutes, 15);
    const access = await ensureCleanerNfcAccessForConfirmedCleaning({ prisma: db, reservationId: f.id, confirmationId: offer.id });
    assert.equal(access.ok, true);
    const own = await db.nfcAssignment.findFirstOrThrow({ where: { nfcCardId: card.id, reservationId: f.id } });
    assert.equal(own.status, "SCHEDULED");
    assert.deepEqual(own.endsAt, f.end); // The former cleaner's extension is not inherited.
    assert.equal((await db.nfcAssignment.findUniqueOrThrow({ where: { id: f.grant.id } })).status, "ACTIVE");
    const snapshot = await materializeCleaningWorkSnapshot(createCleaningWorkSnapshotStore(db), {
      organizationId: f.id, propertyId: f.id, reservationId: f.id, staffMemberId: backupId, confirmationId: offer.id,
    }, incompleteAt);
    assert.equal(snapshot.outcome, "REPLAYED");
    const identity = { workId: backupWork.id, reservationId: f.id, staffMemberId: backupId, confirmationId: offer.id };
    await acceptCleaningTimingConsent(db, identity, incompleteAt);
    const started = await confirmCleaningStart(db, identity, incompleteAt);
    assert.deepEqual(started.startConfirmedAt, incompleteAt);
  });
  await t.test("no viable backup preserves the current work for host review", async () => {
    const f = await fixture(); await db.cleaningWorkIssueReport.update({ where: { id: f.report.id }, data: { kind: "INCOMPLETE", estimatedAt: null } });
    const result = await offerBackupForIncompleteCleaning(db, { ...f.scope, confirmationId: f.id, staffMemberId: f.id }, f.now);
    assert.equal(result.recovery, "NO_VIABLE_BACKUP");
    const work = await db.cleaningWork.findUniqueOrThrow({ where: { id: f.id } });
    assert.equal(work.supersededAt, null); assert.equal(work.cancelledAt, null); assert.equal(work.completionConfirmedAt, null);
    assert.equal((await db.cleaningConfirmation.findUniqueOrThrow({ where: { id: f.id } })).status, "CONFIRMED");
  });
  await t.test("urgent offer outside SMS hours stays pending, alerts host and closes alert on withdrawal", async () => {
    const f = await fixture(new Date("2026-10-07T22:00:00Z"));
    await db.cleaningWorkIssueReport.update({ where: { id: f.report.id }, data: { kind: "INCOMPLETE", estimatedAt: null } });
    const backupId = `${f.id}-backup`;
    await db.staffMember.create({ data: { id: backupId, organizationId: f.id, fullName: "Synthetic backup", phoneE164: "+15555550102" } });
    await db.propertyStaff.create({ data: { propertyId: f.id, staffMemberId: backupId, role: "BACKUP", backupOrder: 1, cleaningDurationCommitmentMinutes: 15 } });
    const offered = await offerBackupForIncompleteCleaning(db, { ...f.scope, confirmationId: f.id, staffMemberId: f.id }, f.now);
    const offerId = offered.nextConfirmationId!;
    await recordDeferredCleaningOfferAttention(db, offerId, f.now);
    const alert = await db.operationalIssue.findUniqueOrThrow({ where: { operationalKey: `CLEANING_OFFER_HOURS:${offerId}` } });
    assert.equal(alert.actionRequired, true);
    assert.equal((alert.metadata as any).smsHoursOverridden, false);
    assert.equal((await db.cleaningConfirmation.findUniqueOrThrow({ where: { id: offerId } })).status, "PENDING");
    assert.equal(await db.messageLog.count({ where: { organizationId: f.id } }), 0);
    await withdrawCleaning(db, { confirmationId: offerId, staffMemberId: backupId, organizationId: f.id }, "decline", f.now);
    assert.equal((await db.operationalIssue.findUniqueOrThrow({ where: { operationalKey: `CLEANING_OFFER_HOURS:${offerId}` } })).workflowState, "RESOLVED");
  });
  await t.test("a failed persisted report remains discoverable after a new recovery scan", async () => {
    const f = await fixture();
    const eligible = await db.cleaningWork.count({ where: { issueReports: { some: {} } } });
    const attempted: string[] = [];
    const first = await processCleaningIssueRecoveries(db, f.now, 1, async (_db, id) => {
      attempted.push(id);
      if (id === f.id) throw new Error("Synthetic interrupted recovery");
    });
    assert.deepEqual(first, { processed: eligible, failures: 1 });
    assert.equal(new Set(attempted).size, eligible);
    assert.ok(await db.cleaningWorkIssueReport.findUnique({ where: { id: f.report.id } }));
    attempted.length = 0;
    const restarted = await processCleaningIssueRecoveries(db, f.now, 1, async (_db, id) => { attempted.push(id); });
    assert.deepEqual(restarted, { processed: eligible, failures: 0 });
    assert.ok(attempted.includes(f.id));
    assert.equal(new Set(attempted).size, eligible);
    assert.equal(f.commands.length, 0);
  });

  await t.test("disabled property blocks hardware even with an eligible more-time report", async () => {
    const f = await fixture();
    await db.property.update({ where: { id: f.id }, data: { pinAIEnabled: false } });
    await assert.rejects(extendCleanerAccess(db, f.scope, f.dependencies), /PIN_AI_NOT_AUTHORIZED/);
    assert.equal(f.commands.length, 0);
    assert.equal(await db.cleaningAccessExtension.count({ where: { reportId: f.report.id } }), 0);
  });

  await t.test("native concurrent requests share one intent and one hardware attempt", { skip: process.env.CLEANER_NATIVE_DB_TEST !== "true" }, async () => {
    const version = await db.$queryRaw<Array<{ version: string }>>`SELECT version() AS version`;
    assert.match(version[0].version, /PostgreSQL/); assert.doesNotMatch(version[0].version, /pglite|wasm|emscripten/i);
    const f = await fixture();
    const second = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
      const results = await Promise.all([
        extendCleanerAccess(db, f.scope, f.dependencies),
        extendCleanerAccess(second, f.scope, f.dependencies),
      ]);
      assert.ok(results.some(r => r.state === "APPLIED"));
      assert.ok(results.every(r => ["APPLIED", "SENDING"].includes(r.state)));
      assert.equal(f.commands.length, 1);
      assert.equal(await db.cleaningAccessExtension.count({ where: { reportId: f.report.id } }), 1);
      assert.equal((await db.cleaningAccessExtension.findUniqueOrThrow({ where: { reportId: f.report.id } })).state, "APPLIED");
    } finally { await second.$disconnect(); }
  });
  await t.test("native expiry does not retire an extension command in flight", { skip: process.env.CLEANER_NATIVE_DB_TEST !== "true" }, async () => {
    const f = await fixture();
    const second = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const remote = new Promise<void>(resolve => { release = resolve; });
    const extending = extendCleanerAccess(db, f.scope, { ...f.dependencies, changeCardPeriod: async (args: any) => {
      f.commands.push(args); entered(); await remote; return {};
    } });
    try {
      await ready;
      await expireNfcAssignments(second, new Date(f.end.getTime() + 1000));
      assert.equal((await second.nfcAssignment.findUniqueOrThrow({ where: { id: f.grant.id } })).status, "PROVISIONING");
      release(); assert.equal((await extending).state, "APPLIED");
      await expireNfcAssignments(second, new Date(f.end.getTime() + 1000));
      assert.equal((await second.nfcAssignment.findUniqueOrThrow({ where: { id: f.grant.id } })).status, "ACTIVE");
      assert.equal(f.commands.length, 1);
    } finally { release(); await extending; await second.$disconnect(); }
  });

});
