import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { parseChecklistItems, saveChecklistTemplate, prepareChecklistSnapshot, readOwnChecklist, setChecklistItem, assertChecklistComplete } from "./cleaning-checklist.service.js";
import { renderCleaningChecklist } from "./cleaning-checklist-render.js";
import { confirmCleaningStart } from "./cleaning-work-start.prisma.js";
import { confirmCleaningCompletion } from "./cleaning-work-completion.prisma.js";
const databaseUrl = process.env.CLEANER_ACCOUNT_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/cleaner_account_test") throw new Error("Use an isolated loopback cleaner_account_test database");
}
test("template validation rejects malformed, oversized and duplicate items", () => {
  for (const items of [[{ id: "one", es: "", en: "", required: true }], [{ id: "one", es: "x", en: "", required: "true" }], Array.from({ length: 51 }, (_, i) => ({ id: String(i), es: "x", en: "", required: false })), [{ id: "one", es: "x", en: "", required: false }, { id: "one", es: "x", en: "", required: false }]]) assert.throws(() => parseChecklistItems(items), /CHECKLIST_INVALID/);
});
test("only required unchecked items block completion; missing legacy checklist does not", async () => {
  const db: any = { cleaningTaskChecklist: { findUnique: async () => ({ items: [{ required: true, checked: true }, { required: false, checked: false }] }) } };
  await assertChecklistComplete(db, "synthetic-reservation");
  db.cleaningTaskChecklist.findUnique = async () => null;
  await assertChecklistComplete(db, "synthetic-reservation");
});
test("portal escapes custom labels and shows the preferred language", () => {
  const checklist: any = { editable: false, items: [{ id: "one", labelEs: "<script>alert(1)</script>", labelEn: "Clean bathroom", checked: false, required: true, version: 0 }] };
  const es = renderCleaningChecklist(checklist, "synthetic", "es");
  assert.match(es, /&lt;script&gt;/);
  assert.doesNotMatch(es, /<script>/);
  assert.match(es, /obligatorio/);
  assert.match(renderCleaningChecklist(checklist, "synthetic", "en"), /Clean bathroom/);
});
test("property checklist snapshots, progress and completion against isolated SQL", { skip: !databaseUrl }, async t => {
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
  const id = `checklist-test-${randomUUID()}`;
  const now = new Date();
  const start = new Date(now.getTime() - 5 * 60000);
  const checkout = new Date(start.getTime() - 30 * 60000);
  await db.organization.create({ data: { id, name: "Synthetic checklist organization" } });
  t.after(async () => {
    await db.cleaningWork.deleteMany({ where: { propertyId: id } });
    await db.cleaningConfirmation.deleteMany({ where: { propertyId: id } });
    await db.reservation.deleteMany({ where: { propertyId: id } });
    await db.property.delete({ where: { id } });
    await db.staffMember.deleteMany({ where: { organizationId: id } });
    await db.organization.delete({ where: { id } });
    await db.$disconnect();
  });
  await db.property.create({ data: { id, organizationId: id, name: "Synthetic checklist property", status: "ACTIVE", cleaningStartOffsetMinutes: 30 } });
  for (const suffix of ["a", "b"]) {
    await db.staffMember.create({ data: { id: `${id}-${suffix}`, organizationId: id, fullName: `Synthetic cleaner ${suffix}`, ttlockCardRef: `synthetic-card-${suffix}` } });
    await db.propertyStaff.create({ data: { propertyId: id, staffMemberId: `${id}-${suffix}`, role: suffix === "a" ? "PRIMARY" : "BACKUP", cleaningDurationCommitmentMinutes: 20 } });
  }
  const templateInput = { propertyId: id, organizationId: id, userId: "synthetic-host", revision: 0, items: [{ id: "bath", es: "Limpiar baño", en: "Clean bathroom", required: true }, { id: "floor", es: "Barrer", en: "Sweep", required: false }] };
  await saveChecklistTemplate(db, templateInput);
  const createReservation = (reservationId: string) => db.reservation.create({ data: { id: reservationId, propertyId: id, source: "INTERNAL_DEMO_DIRECT_BOOKING", guestName: "Synthetic guest", status: "ACTIVE", checkIn: new Date(checkout.getTime() - 86400000), checkOut: checkout } });
  await createReservation(id);
  await db.cleaningConfirmation.create({ data: { id, reservationId: id, propertyId: id, staffMemberId: `${id}-a`, token: randomUUID(), status: "CONFIRMED" } });
  const work = await db.cleaningWork.create({ data: { reservationId: id, propertyId: id, staffMemberId: `${id}-a`, confirmationId: id, scheduledStartAt: start, durationCommitmentMinutes: 20, startConfirmationGraceMinutes: 5, followupGraceMinutes: 15, timingConsentVersion: "v1", timingConsentAcceptedAt: checkout } });
  const own = { confirmationId: id, staffMemberId: `${id}-a`, organizationId: id };
  let checklist = await prepareChecklistSnapshot(db, id);
  await t.test("snapshot is fixed and host edits affect only subsequent tasks", async () => {
    assert.equal(checklist.items.length, 2);
    await saveChecklistTemplate(db, { ...templateInput, revision: 1, items: [{ id: "new", es: "Nuevo punto", en: "New item", required: true }] });
    assert.deepEqual(await prepareChecklistSnapshot(db, id), checklist);
    await assert.rejects(saveChecklistTemplate(db, templateInput), /REVISION_CONFLICT/);
    await assert.rejects(saveChecklistTemplate(db, { ...templateInput, organizationId: "foreign" }), /PROPERTY_NOT_FOUND/);
  });
  await t.test("progress requires start and remains within the cleaner scope", async () => {
    await assert.rejects(setChecklistItem(db, { ...own, itemId: checklist.items[0]!.id, checked: true, version: 0 }), /NOT_EDITABLE/);
    await assert.rejects(readOwnChecklist(db, { ...own, organizationId: "foreign" }), /NOT_AVAILABLE/);
    await confirmCleaningStart(db, { workId: work.id, reservationId: id, staffMemberId: `${id}-a`, confirmationId: id });
    await assert.rejects(confirmCleaningCompletion(db, { workId: work.id, reservationId: id, staffMemberId: `${id}-a`, confirmationId: id }), /REQUIRED_ITEMS_PENDING/);
    await setChecklistItem(db, { ...own, itemId: checklist.items[0]!.id, checked: true, version: 0 });
    await assert.rejects(setChecklistItem(db, { ...own, itemId: checklist.items[0]!.id, checked: false, version: 0 }), /VERSION_CONFLICT/);
  });
  await t.test("backup inherits the same task/checklist/progress and old cleaner loses access", async () => {
    await db.cleaningConfirmation.update({ where: { id }, data: { status: "EXPIRED" } });
    await db.cleaningWork.update({ where: { id: work.id }, data: { supersededAt: new Date() } });
    await db.cleaningConfirmation.create({ data: { id: `${id}-backup`, reservationId: id, propertyId: id, staffMemberId: `${id}-b`, token: randomUUID(), status: "CONFIRMED" } });
    const backupWork = await db.cleaningWork.create({ data: { reservationId: id, propertyId: id, staffMemberId: `${id}-b`, confirmationId: `${id}-backup`, scheduledStartAt: start, durationCommitmentMinutes: 20, startConfirmationGraceMinutes: 5, followupGraceMinutes: 15, timingConsentVersion: "v1", timingConsentAcceptedAt: checkout, startConfirmedAt: start } });
    const backupOwn = { confirmationId: `${id}-backup`, staffMemberId: `${id}-b`, organizationId: id };
    const backup = await readOwnChecklist(db, backupOwn);
    assert.equal(backup.id, checklist.id);
    assert.equal(backup.items[0]!.checked, true);
    assert.equal(backup.items[0]!.checkedByStaffMemberId, `${id}-a`);
    await assert.rejects(readOwnChecklist(db, own), /NOT_AVAILABLE/);
    const item = backup.items[1]!;
    await setChecklistItem(db, { ...backupOwn, itemId: item.id, checked: true, version: item.version });
    const events = await db.cleaningChecklistItemEvent.findMany({ where: { item: { checklistId: checklist.id } }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(events.map(event => event.actorStaffMemberId), [`${id}-a`, `${id}-b`]);
    await confirmCleaningCompletion(db, { workId: backupWork.id, reservationId: id, staffMemberId: `${id}-b`, confirmationId: `${id}-backup` });
    await assert.rejects(setChecklistItem(db, { ...backupOwn, itemId: item.id, checked: false, version: item.version + 1 }), /NOT_EDITABLE/);
    assert.equal((await db.staffMember.findUniqueOrThrow({ where: { id: `${id}-b` } })).ttlockCardRef, "synthetic-card-b");
  });
  await t.test("unstarted assignments use the current template; started historical cleanings stay empty", async () => {
    await createReservation(`${id}-next`);
    await db.cleaningConfirmation.create({ data: { reservationId: `${id}-next`, propertyId: id, staffMemberId: `${id}-a`, token: randomUUID(), status: "PENDING" } });
    const next = await prepareChecklistSnapshot(db, `${id}-next`);
    assert.equal(next.templateRevision, 2);
    assert.equal(next.items[0]!.labelEs, "Nuevo punto");
    await createReservation(`${id}-legacy`);
    await db.cleaningConfirmation.create({ data: { reservationId: `${id}-legacy`, propertyId: id, staffMemberId: `${id}-a`, token: randomUUID(), status: "CONFIRMED", createdAt: new Date(now.getTime() - 86400000) } });
    assert.equal((await prepareChecklistSnapshot(db, `${id}-legacy`)).items.length, 1);
    await createReservation(`${id}-started`);
    const startedOffer = await db.cleaningConfirmation.create({ data: { reservationId: `${id}-started`, propertyId: id, staffMemberId: `${id}-a`, token: randomUUID(), status: "CONFIRMED" } });
    await db.cleaningWork.create({ data: { reservationId: `${id}-started`, propertyId: id, staffMemberId: `${id}-a`, confirmationId: startedOffer.id, scheduledStartAt: start, durationCommitmentMinutes: 20, startConfirmationGraceMinutes: 5, followupGraceMinutes: 15, timingConsentVersion: "v1", timingConsentAcceptedAt: checkout, startConfirmedAt: start } });
    const startedChecklist = await prepareChecklistSnapshot(db, `${id}-started`);
    assert.equal(startedChecklist.legacy, true);
    assert.equal(startedChecklist.items.length, 0);
  });
  await t.test("saving a template fills empty assigned lists and preserves populated, started and closed lists", async () => {
    const ids = Object.fromEntries(["empty", "legacy-empty", "started-empty", "completed-empty", "cancelled-empty", "expired-empty", "populated", "read-repair"].map(kind => [kind, `${id}-${kind}`]));
    for (const [kind, reservationId] of Object.entries(ids)) {
      await createReservation(reservationId);
      if (kind === "cancelled-empty") await db.reservation.update({ where: { id: reservationId }, data: { status: "CANCELLED" } });
      const offer = await db.cleaningConfirmation.create({ data: { reservationId, propertyId: id, staffMemberId: `${id}-a`, token: randomUUID(),
        status: kind === "expired-empty" ? "EXPIRED" : "CONFIRMED", createdAt: new Date(now.getTime() - 86400000) } });
      await db.cleaningTaskChecklist.create({ data: { reservationId, propertyId: id, templateRevision: 0, legacy: kind === "legacy-empty",
        ...(kind === "populated" ? { items: { create: { templateKey: "original", position: 0, labelEs: "Original", labelEn: "Original", required: true, checked: true } } } : {}) } });
      if (kind === "started-empty" || kind === "completed-empty") await db.cleaningWork.create({ data: {
        reservationId, propertyId: id, staffMemberId: `${id}-a`, confirmationId: offer.id, scheduledStartAt: start,
        durationCommitmentMinutes: 20, startConfirmationGraceMinutes: 5, followupGraceMinutes: 15,
        ...(kind === "started-empty" ? { startConfirmedAt: start } : { completionConfirmedAt: now }),
      } });
    }
    // Repairs lists already saved empty before this fix, without requiring the host to save again.
    const repaired = await prepareChecklistSnapshot(db, ids["read-repair"]!);
    assert.equal(repaired.templateRevision, 2); assert.equal(repaired.items.length, 1);
    const populatedBefore = await prepareChecklistSnapshot(db, ids.populated!);
    const saved = await saveChecklistTemplate(db, { ...templateInput, revision: 2, items: [
      { id: "late", es: "Lista posterior", en: "Later checklist", required: true },
    ] });
    assert.equal(saved.revision, 3);
    for (const kind of ["empty", "legacy-empty"]) {
      const row = await db.cleaningTaskChecklist.findUniqueOrThrow({ where: { reservationId: ids[kind]! }, include: { items: true } });
      assert.equal(row.templateRevision, 3); assert.equal(row.legacy, false);
      assert.equal(row.items.length, 1); assert.equal(row.items[0]!.labelEs, "Lista posterior");
      assert.equal(row.items[0]!.checked, false);
      await assert.rejects(assertChecklistComplete(db, ids[kind]!), /REQUIRED_ITEMS_PENDING/);
    }
    for (const kind of ["started-empty", "completed-empty", "cancelled-empty", "expired-empty"]) {
      const row = await db.cleaningTaskChecklist.findUniqueOrThrow({ where: { reservationId: ids[kind]! }, include: { items: true } });
      assert.equal(row.templateRevision, 0); assert.equal(row.items.length, 0);
      assert.equal((await prepareChecklistSnapshot(db, ids[kind]!)).items.length, 0);
    }
    assert.deepEqual(await prepareChecklistSnapshot(db, ids.populated!), populatedBefore);
    assert.deepEqual(await prepareChecklistSnapshot(db, ids["read-repair"]!), repaired);
    const after = await prepareChecklistSnapshot(db, ids.empty!);
    assert.deepEqual(await prepareChecklistSnapshot(db, ids.empty!), after);
    const concurrentId = `${id}-concurrent-empty`;
    await createReservation(concurrentId);
    await db.cleaningConfirmation.create({ data: { reservationId: concurrentId, propertyId: id, staffMemberId: `${id}-a`, token: randomUUID(), status: "CONFIRMED" } });
    await db.cleaningTaskChecklist.create({ data: { reservationId: concurrentId, propertyId: id, templateRevision: 0 } });
    const [firstRead, secondRead] = await Promise.all([
      prepareChecklistSnapshot(db, concurrentId), prepareChecklistSnapshot(db, concurrentId),
    ]);
    assert.deepEqual(firstRead, secondRead);
    assert.equal(firstRead.items.length, 1);
    assert.equal(await db.cleaningTaskChecklistItem.count({ where: { checklistId: firstRead.id } }), 1);
  });

});
