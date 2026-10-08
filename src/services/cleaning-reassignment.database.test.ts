import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createCleaningConfirmation } from "./cleaning-confirmation.service.js";
import { acceptCleaningOffer, withdrawCleaning } from "./cleaning-reassignment.service.js";
import { prepareChecklistSnapshot, saveChecklistTemplate } from "./cleaning-checklist.service.js";
import { confirmCleaningStart } from "./cleaning-work-start.prisma.js";
import { persistCleaningAuditAttention } from "./cleaning-reassignment-attention.service.js";
import { mapReservationCleaningOperationalItems } from "../apms/reservation-operational-intelligence.mapper.js";
import { scheduleBackupAlongsideCancelledProgrammedGrant } from "./cleaner-unused-grant.service.js";
const databaseUrl = process.env.CLEANER_ACCOUNT_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/cleaner_account_test") throw new Error("Use isolated loopback cleaner_account_test only");
}
test("explicit cancellation and sequential replacement in isolated SQL", { skip: !databaseUrl }, async t => {
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
  const id = `replacement-${randomUUID()}`;
  const now = new Date(); const start = new Date(now.getTime() + 10 * 60000); const checkout = new Date(start.getTime() - 30 * 60000);
  await db.organization.create({ data: { id, name: "Synthetic replacement org" } });
  t.after(async () => {
    await db.nfcAssignment.deleteMany({ where: { reservationId: id } });
    await db.nfcCard.deleteMany({ where: { propertyId: id } });
    await db.operationalIssue.deleteMany({ where: { organizationId: id } });
    await db.messageLog.deleteMany({ where: { organizationId: id } });
    await db.cleaningWork.deleteMany({ where: { propertyId: id } });
    await db.cleaningConfirmation.deleteMany({ where: { propertyId: id } });
    await db.reservation.deleteMany({ where: { propertyId: id } });
    await db.property.delete({ where: { id } });
    await db.staffMember.deleteMany({ where: { organizationId: id } });
    await db.organization.delete({ where: { id } }); await db.$disconnect();
  });
  await db.property.create({ data: { id, organizationId: id, name: "Synthetic replacement property", status: "ACTIVE", cleaningNfcEnabled: true, cleaningStartOffsetMinutes: 30 } });
  for (const [index, suffix] of ["a", "b", "c"].entries()) {
    await db.staffMember.create({ data: { id: `${id}-${suffix}`, organizationId: id, fullName: `Synthetic ${suffix}`, phoneE164: `+1555555010${index}`, ttlockCardRef: `synthetic-${suffix}` } });
    await db.propertyStaff.create({ data: { propertyId: id, staffMemberId: `${id}-${suffix}`, role: index === 0 ? "PRIMARY" : "BACKUP", backupOrder: index, cleaningDurationCommitmentMinutes: suffix === "b" ? 60 : 15 } });
  }
  await db.reservation.create({ data: { id, propertyId: id, source: "INTERNAL_DEMO_DIRECT_BOOKING", guestName: "Synthetic guest", status: "ACTIVE", checkIn: new Date(checkout.getTime() - 86400000), checkOut: checkout } });
  await db.reservation.create({ data: { id: `${id}-arrival`, propertyId: id, guestName: "Synthetic arrival", status: "ACTIVE", checkIn: new Date(start.getTime() + 25 * 60000), checkOut: new Date(start.getTime() + 86400000) } });
  await saveChecklistTemplate(db, { propertyId: id, organizationId: id, userId: "synthetic-host", revision: 0, items: [{ id: "bath", es: "Baño", en: "Bathroom", required: true }] });
  const offer = await db.cleaningConfirmation.create({ data: { id, reservationId: id, propertyId: id, staffMemberId: `${id}-a`, token: randomUUID(), status: "PENDING" } });
  const snapshot = await prepareChecklistSnapshot(db, id);
  const own = { confirmationId: offer.id, staffMemberId: `${id}-a`, organizationId: id };
  const auditOffer = async (confirmationId: string, reservationId: string, status: string) => {
    const items = mapReservationCleaningOperationalItems({
      organizationId: id, propertyId: id, reservationId, cleaningConfirmationId: confirmationId,
      cleaningConfirmationStatus: status, cleanerAccessReady: false, cleanerAccessAutopilotAttempted: false,
      decisionId: "synthetic-audit", sourceAuditEntryId: "synthetic-audit", signalAt: now,
    }).filter(item => item.operationalKey.startsWith("CLEANING_CONFIRMATION:"));
    await persistCleaningAuditAttention(db, items);
  };
  await t.test("foreign identity cannot cancel or accept", async () => {
    await assert.rejects(acceptCleaningOffer(db, { ...own, organizationId: "foreign" }, now), /NOT_AVAILABLE/);
    await assert.rejects(withdrawCleaning(db, { ...own, staffMemberId: `${id}-c` }, "cancel", now), /NOT_AVAILABLE/);
  });
  await t.test("acceptance records own duration but no start or consent", async () => {
    assert.equal((await acceptCleaningOffer(db, own, now)).replayed, false);
    assert.equal((await acceptCleaningOffer(db, own, now)).replayed, true);
    const work = await db.cleaningWork.findFirstOrThrow({ where: { confirmationId: id } });
    assert.equal(work.durationCommitmentMinutes, 15); assert.equal(work.startConfirmedAt, null); assert.equal(work.timingConsentAcceptedAt, null);
  });
  let replacementId = "";
  await t.test("window start blocks cancellation without an explicit start and rolls back all writes", async () => {
    for (const when of [start, new Date(start.getTime() + 1)]) {
      await assert.rejects(withdrawCleaning(db, own, "cancel", when), /CANCELLATION_WINDOW_CLOSED/);
      assert.equal((await db.cleaningConfirmation.findUniqueOrThrow({ where: { id } })).status, "CONFIRMED");
      const work = await db.cleaningWork.findFirstOrThrow({ where: { confirmationId: id } });
      assert.equal(work.startConfirmedAt, null);
      assert.equal(work.cancelledAt, null);
      assert.equal(await db.cleaningConfirmation.count({ where: { reservationId: id } }), 1);
    }
    // The deadline follows the canonical window if checkout changes.
    await db.reservation.update({ where: { id }, data: { checkOut: new Date(checkout.getTime() - 20 * 60000) } });
    await assert.rejects(withdrawCleaning(db, own, "cancel", now), /CANCELLATION_WINDOW_CLOSED/);
    await db.reservation.update({ where: { id }, data: { checkOut: checkout } });
  });
  await t.test("cancel skips too-slow first backup, preserves checklist and access reference", async () => {
    const card = await db.nfcCard.create({ data: { propertyId: id, label: "synthetic-a", ttlockCardId: 123 } });
    const grants: Record<string, string> = {};
    for (const [name, role, status, retryCount] of [
      ["unused", "CLEANING", "SCHEDULED", 0],
      ["programmed", "CLEANING", "ACTIVE", 1],
      ["inflight", "CLEANING", "PROVISIONING", 1],
      ["attempted", "CLEANING", "SCHEDULED", 1],
      ["journal", "CLEANING", "SCHEDULED", 0],
      ["guest", "GUEST", "SCHEDULED", 0],
    ] as const) {
      const grant = await db.nfcAssignment.create({ data: { reservationId: id, nfcCardId: card.id, role, status, retryCount, startsAt: start, endsAt: new Date(start.getTime() + 25 * 60000) } });
      grants[name] = grant.id;
    }
    await db.cleanerNfcProgrammingAttempt.create({ data: { nfcAssignmentId: grants.journal!, confirmationId: id, attemptNumber: 1, organizationId: id, ttlockLockId: 456, ttlockCardId: 123, startsAt: start, endsAt: new Date(start.getTime() + 25 * 60000) } });
    await db.staffAssignment.create({ data: { reservationId: id, staffMemberId: own.staffMemberId, method: "NFC_TIMEBOUND", status: "SCHEDULED", startsAt: start, endsAt: new Date(start.getTime() + 25 * 60000) } });
    await db.operationalIssue.create({ data: {
      operationalKey: `CLEANING_CONFIRMATION:${id}`, issueCode: "CLEANING_CONFIRMATION_PENDING",
      title: "Waiting", issue: "Synthetic pending offer", engine: "Cleaning", severity: "INFO",
      workflowState: "WAITING", visibility: "HOST", responsibleActor: "CLEANER",
      actionRequired: false, canAutoResolve: true, autoResolveStatus: "AVAILABLE",
      organizationId: id, propertyId: id, reservationId: id, sourceType: "ENGINE_EVENT", actionTarget: "CLEANING",
    } });
    const result = await withdrawCleaning(db, own, "cancel", now);
    assert.equal((await db.nfcAssignment.findUniqueOrThrow({ where: { id: grants.unused! } })).status, "ENDED");
    assert.equal((await db.nfcAssignment.findUniqueOrThrow({ where: { id: grants.unused! } })).lastError, "CLEANER_UNUSED_GRANT_CANCELLED");
    for (const [name, status] of [["programmed", "ACTIVE"], ["inflight", "PROVISIONING"], ["attempted", "SCHEDULED"], ["journal", "SCHEDULED"], ["guest", "SCHEDULED"]]) {
      assert.equal((await db.nfcAssignment.findUniqueOrThrow({ where: { id: grants[name]! } })).status, status);
    }
    assert.equal((await db.staffAssignment.findUniqueOrThrow({ where: { reservationId_staffMemberId: { reservationId: id, staffMemberId: own.staffMemberId } } })).status, "CANCELLED");
    assert.equal(result.recovery, "BACKUP_OFFER_PENDING"); replacementId = result.nextConfirmationId!;
    const replacement = await db.cleaningConfirmation.findUniqueOrThrow({ where: { id: replacementId } });
    assert.equal(replacement.staffMemberId, `${id}-c`); assert.equal(replacement.status, "PENDING");
    const previousAttention = await db.operationalIssue.findUniqueOrThrow({ where: { operationalKey: `CLEANING_CONFIRMATION:${id}` } });
    assert.equal(previousAttention.workflowState, "RESOLVED");
    assert.equal(previousAttention.resolutionCode, "REPLACEMENT_OFFER_CREATED");
    assert.equal(previousAttention.actionRequired, false);
    await auditOffer(id, id, "PENDING");
    assert.equal((await db.operationalIssue.findUniqueOrThrow({ where: { operationalKey: `CLEANING_CONFIRMATION:${id}` } })).issueCode, "CLEANING_OFFER_SUPERSEDED");
    await auditOffer(replacementId, id, "PENDING");
    assert.equal((await db.operationalIssue.findUniqueOrThrow({ where: { operationalKey: `CLEANING_CONFIRMATION:${replacementId}` } })).workflowState, "WAITING");
    assert.equal((await db.cleaningWork.findFirstOrThrow({ where: { confirmationId: id } })).cancelledAt?.getTime(), now.getTime());
    assert.equal((await prepareChecklistSnapshot(db, id)).id, snapshot.id);
    assert.equal((await db.staffMember.findUniqueOrThrow({ where: { id: `${id}-a` } })).ttlockCardRef, "synthetic-a");
    assert.equal(await db.staffAssignment.count({ where: { reservationId: id } }), 1);
    assert.equal((await withdrawCleaning(db, own, "cancel", now)).replayed, true);
    const oldWork = await db.cleaningWork.findFirstOrThrow({ where: { confirmationId: id } });
    await assert.rejects(confirmCleaningStart(db, { workId: oldWork.id, reservationId: id, staffMemberId: own.staffMemberId, confirmationId: id }, start), /WORK_CLOSED/);
    assert.equal(await db.cleaningConfirmation.count({ where: { reservationId: id, status: "PENDING" } }), 1);
    assert.equal((await createCleaningConfirmation({ reservationId: id, propertyId: id, staffMemberId: own.staffMemberId }))?.id, replacementId);
    assert.equal(await db.cleaningConfirmation.count({ where: { reservationId: id, status: "PENDING" } }), 1);
    await assert.rejects(acceptCleaningOffer(db, own, now), /NOT_ACTIONABLE/);
  });
  const backup = () => ({ confirmationId: replacementId, staffMemberId: `${id}-c`, organizationId: id });
  await t.test("acceptance rejects changed capacity and leaves offer pending", async () => {
    await db.propertyStaff.update({ where: { propertyId_staffMemberId: { propertyId: id, staffMemberId: `${id}-c` } }, data: { cleaningDurationCommitmentMinutes: 60 } });
    await assert.rejects(acceptCleaningOffer(db, backup(), now), /NOT_VIABLE/);
    assert.equal((await db.cleaningConfirmation.findUniqueOrThrow({ where: { id: replacementId } })).status, "PENDING");
    await db.propertyStaff.update({ where: { propertyId_staffMemberId: { propertyId: id, staffMemberId: `${id}-c` } }, data: { cleaningDurationCommitmentMinutes: 15 } });
  });
  await t.test("response expiry and conflicting work are rechecked at acceptance", async () => {
    const offer = await db.cleaningConfirmation.findUniqueOrThrow({ where: { id: replacementId } });
    const log = await db.messageLog.create({ data: { organizationId: id, propertyId: id, reservationId: id, channel: "sms", to: "synthetic", provider: "twilio", status: "SENT", body: offer.token, createdAt: new Date(now.getTime() - 120 * 60000) } });
    await assert.rejects(acceptCleaningOffer(db, backup(), now), /RESPONSE_EXPIRED/);
    await db.messageLog.delete({ where: { id: log.id } });
    const competing = await db.cleaningWork.create({ data: { reservationId: `${id}-arrival`, propertyId: id, staffMemberId: `${id}-c`, scheduledStartAt: start, durationCommitmentMinutes: 15, startConfirmationGraceMinutes: 30, followupGraceMinutes: 15 } });
    await assert.rejects(acceptCleaningOffer(db, backup(), now), /NOT_VIABLE/);
    await db.cleaningWork.delete({ where: { id: competing.id } });
    const other = await db.cleaningConfirmation.create({ data: { reservationId: id, propertyId: id, staffMemberId: `${id}-b`, token: randomUUID(), status: "PENDING" } });
    await assert.rejects(acceptCleaningOffer(db, backup(), now), /OTHER_OFFER_ACTIVE/);
    await db.cleaningConfirmation.delete({ where: { id: other.id } });
  });
  await t.test("replacement accepts and can start; subsequent cancellation loses", async () => {
    await acceptCleaningOffer(db, backup(), now);
    const work = await db.cleaningWork.findFirstOrThrow({ where: { confirmationId: replacementId } });
    assert.equal(work.durationCommitmentMinutes, 15); assert.equal(work.startConfirmedAt, null);
    const former = await db.nfcAssignment.findFirstOrThrow({ where: { reservationId: id, role: "CLEANING", status: "ACTIVE" } });
    const before = { ...former };
    const ownCard = await db.nfcCard.create({ data: { propertyId: id, label: "synthetic-c", ttlockCardId: 789 } });
    const input = { reservationId: id, propertyId: id, confirmationId: replacementId,
      grantId: former.id, grantCardId: former.nfcCardId, replacementCardId: ownCard.id,
      startsAt: start, endsAt: former.endsAt };
    assert.equal(await scheduleBackupAlongsideCancelledProgrammedGrant(db, { ...input, confirmationId: id }), null);
    assert.equal(await scheduleBackupAlongsideCancelledProgrammedGrant(db, { ...input, propertyId: "foreign" }), null);
    assert.equal(await scheduleBackupAlongsideCancelledProgrammedGrant(db, { ...input, replacementCardId: former.nfcCardId }), null);
    const overlap = await db.nfcAssignment.create({ data: { reservationId: `${id}-arrival`, nfcCardId: ownCard.id, role: "CLEANING", status: "SCHEDULED", startsAt: start, endsAt: former.endsAt } });
    assert.equal(await scheduleBackupAlongsideCancelledProgrammedGrant(db, input), null);
    await db.nfcAssignment.delete({ where: { id: overlap.id } });
    const scheduledId = await scheduleBackupAlongsideCancelledProgrammedGrant(db, input);
    assert.ok(scheduledId);
    assert.equal(await scheduleBackupAlongsideCancelledProgrammedGrant(db, input), scheduledId);
    assert.equal(await db.nfcAssignment.count({ where: { reservationId: id, nfcCardId: ownCard.id } }), 1);
    const scheduled = await db.nfcAssignment.findUniqueOrThrow({ where: { id: scheduledId } });
    assert.equal(scheduled.status, "SCHEDULED"); assert.equal(scheduled.retryCount, 0);
    assert.equal(scheduled.startsAt.getTime(), start.getTime());
    assert.deepEqual(await db.nfcAssignment.findUniqueOrThrow({ where: { id: former.id } }), before);
    for (const status of ["PROVISIONING", "FAILED"] as const) {
      await db.nfcAssignment.update({ where: { id: former.id }, data: { status } });
      const interrupted = await db.nfcAssignment.findUniqueOrThrow({ where: { id: former.id } });
      assert.equal(await scheduleBackupAlongsideCancelledProgrammedGrant(db, input), scheduledId);
      assert.deepEqual(await db.nfcAssignment.findUniqueOrThrow({ where: { id: former.id } }), interrupted);
      assert.equal(await db.nfcAssignment.count({ where: { reservationId: id, nfcCardId: ownCard.id } }), 1);
    }
    await db.cleaningWork.update({ where: { id: work.id }, data: { timingConsentVersion: "v1", timingConsentAcceptedAt: now } });
    await confirmCleaningStart(db, { workId: work.id, reservationId: id, staffMemberId: `${id}-c`, confirmationId: replacementId }, start);
    await assert.rejects(withdrawCleaning(db, backup(), "cancel", start), /ALREADY_STARTED/);
    assert.equal((await db.cleaningConfirmation.findUniqueOrThrow({ where: { id: replacementId } })).status, "CONFIRMED");
  });
  await t.test("pending decline exhaustion is durable and cannot later accept", async () => {
    // Separate task with no remaining alternatives; start missing alone does not withdraw anything.
    const rid = `${id}-other`;
    await db.reservation.create({ data: { id: rid, propertyId: id, source: "INTERNAL_DEMO_DIRECT_BOOKING", guestName: "Synthetic other", status: "ACTIVE", checkIn: new Date(start.getTime() + 86400000), checkOut: new Date(checkout.getTime() + 172800000) } });
    for (const suffix of ["a", "b", "c"]) await db.cleaningConfirmation.create({ data: { id: `${rid}-${suffix}`, reservationId: rid, propertyId: id, staffMemberId: `${id}-${suffix}`, token: randomUUID(), status: suffix === "a" ? "PENDING" : "DECLINED" } });
    const scope = { ...own, confirmationId: `${rid}-a` };
    const failingDb = { $transaction: (run: any, options: any) => db.$transaction(tx => run(new Proxy(tx, {
      get(target, key) {
        if (key === "operationalIssue") return new Proxy(target.operationalIssue, {
          get(delegate, method) { return method === "upsert" ? async () => { throw new Error("synthetic attention persistence failure"); } : Reflect.get(delegate, method); },
        });
        return Reflect.get(target, key);
      },
    })), options) } as unknown as PrismaClient;
    await assert.rejects(withdrawCleaning(failingDb, scope, "decline", now), /synthetic attention persistence failure/);
    assert.equal((await db.cleaningConfirmation.findUniqueOrThrow({ where: { id: scope.confirmationId } })).status, "PENDING");
    assert.equal((await withdrawCleaning(db, scope, "decline", now)).recovery, "NO_VIABLE_BACKUP");
    const key = `CLEANING_CONFIRMATION:${scope.confirmationId}`;
    const issue = await db.operationalIssue.findUniqueOrThrow({ where: { operationalKey: key } });
    assert.equal(issue.issueCode, "CLEANING_BACKUPS_EXHAUSTED");
    assert.equal(issue.organizationId, id); assert.equal(issue.reservationId, rid);
    assert.equal(issue.workflowState, "ACTION_REQUIRED"); assert.equal(issue.responsibleActor, "HOST");
    assert.equal(issue.nextAutomaticStep, null); assert.equal(issue.autoResolveStatus, "NOT_SUPPORTED");
    await auditOffer(scope.confirmationId, rid, "DECLINED");
    await auditOffer(scope.confirmationId, rid, "PENDING");
    assert.equal((await db.operationalIssue.findUniqueOrThrow({ where: { operationalKey: key } })).issueCode, "CLEANING_BACKUPS_EXHAUSTED");
    assert.equal(await db.operationalIssueTransition.count({ where: { issueId: issue.id } }), 1);
    assert.equal((await withdrawCleaning(db, scope, "decline", now)).replayed, true);
    assert.equal(await db.operationalIssueTransition.count({ where: { issueId: issue.id } }), 1);
    assert.equal(await db.messageLog.count({ where: { reservationId: rid } }), 0);
    await assert.rejects(acceptCleaningOffer(db, scope, now), /NOT_ACTIONABLE/);
    // Adding a new configured cleaner still requires an explicit new offer and acceptance.
    await db.staffMember.create({ data: { id: `${id}-d`, organizationId: id, fullName: "Synthetic d", phoneE164: "+15555550109" } });
    await db.propertyStaff.create({ data: { propertyId: id, staffMemberId: `${id}-d`, role: "BACKUP", backupOrder: 4, cleaningDurationCommitmentMinutes: 15 } });
    const newOffer = await db.cleaningConfirmation.create({ data: { reservationId: rid, propertyId: id, staffMemberId: `${id}-d`, token: randomUUID(), status: "PENDING" } });
    const restored = { ...scope, confirmationId: newOffer.id, staffMemberId: `${id}-d` };
    await acceptCleaningOffer(db, restored, now);
    await auditOffer(newOffer.id, rid, "CONFIRMED");
    const confirmedAttention = await db.operationalIssue.findUniqueOrThrow({ where: { operationalKey: `CLEANING_CONFIRMATION:${newOffer.id}` } });
    assert.equal(confirmedAttention.workflowState, "RESOLVED");
    const resolved = await db.operationalIssue.findUniqueOrThrow({ where: { operationalKey: key } });
    assert.equal(resolved.workflowState, "RESOLVED"); assert.equal(resolved.resolutionCode, "REPLACEMENT_CLEANER_ACCEPTED");
    await auditOffer(scope.confirmationId, rid, "DECLINED");
    assert.equal((await db.operationalIssue.findUniqueOrThrow({ where: { operationalKey: key } })).workflowState, "RESOLVED");
    assert.equal((await db.cleaningWork.findFirstOrThrow({ where: { confirmationId: newOffer.id } })).completionConfirmedAt, null);
    assert.equal((await withdrawCleaning(db, restored, "cancel", now)).recovery, "NO_VIABLE_BACKUP");
    const reopened = await db.operationalIssue.findUniqueOrThrow({ where: { operationalKey: `CLEANING_CONFIRMATION:${newOffer.id}` } });
    assert.equal(reopened.id, confirmedAttention.id); assert.equal(reopened.reopenedCount, 1);
    assert.equal(reopened.issueCode, "CLEANING_BACKUPS_EXHAUSTED");
    assert.equal(await db.operationalIssue.count({ where: { reservationId: rid, workflowState: "ACTION_REQUIRED" } }), 1);
    assert.equal((await db.operationalIssue.findUniqueOrThrow({ where: { operationalKey: key } })).workflowState, "RESOLVED");
  });
});
