import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { createCleaningWorkSnapshotStore } from "./cleaning-work-snapshot.prisma.js";
import { materializeCleaningWorkSnapshot, type CleaningWorkScope } from "./cleaning-work-snapshot.service.js";

// Fail rather than skip. This test must never use a production or staging URL.
const url = new URL(process.env.DATABASE_URL ?? "http://missing.invalid");
if (process.env.CLEANING_WORK_ISOLATED_DB !== "1" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/cleaning_followup_test") {
  throw new Error("ISOLATED_CLEANING_WORK_DATABASE_REQUIRED");
}
const db = new PrismaClient();
const store = createCleaningWorkSnapshotStore(db);

async function fixture(): Promise<CleaningWorkScope> {
  const id = randomUUID();
  const scope = { organizationId: `org-${id}`, propertyId: `property-${id}`,
    reservationId: `reservation-${id}`, staffMemberId: `staff-${id}`, confirmationId: `confirmation-${id}` };
  await db.$executeRaw`INSERT INTO "Property" VALUES (${scope.propertyId}, ${scope.organizationId}, 'ACTIVE', true, 30)`;
  await db.$executeRaw`INSERT INTO "Reservation" VALUES (${scope.reservationId}, ${scope.propertyId}, 'ACTIVE', TIMESTAMP '2026-09-28 15:00:00')`;
  await addCleaner(scope);
  return scope;
}
async function addCleaner(scope: CleaningWorkScope) {
  await db.$executeRaw`INSERT INTO "StaffMember" VALUES (${scope.staffMemberId}, ${scope.organizationId}, true)`;
  await db.$executeRaw`INSERT INTO "PropertyStaff" (
    "id", "propertyId", "staffMemberId", "isActive", "cleaningDurationCommitmentMinutes"
  ) VALUES (${randomUUID()}, ${scope.propertyId}, ${scope.staffMemberId}, true, 120)`;
  await db.$executeRaw`INSERT INTO "CleaningConfirmation" VALUES (
    ${scope.confirmationId}, ${scope.propertyId}, ${scope.reservationId}, ${scope.staffMemberId}, 'CONFIRMED')`;
}
async function count(scope: CleaningWorkScope) {
  return db.cleaningWork.count({ where: { reservationId: scope.reservationId } });
}

test("CleaningWork persistence on disposable PostgreSQL", { timeout: 60000 }, async t => {
  try {
    await t.test("concurrent same-work requests persist one record and replay", async () => {
      const scope = await fixture();
      const results = await Promise.all([materializeCleaningWorkSnapshot(store, scope), materializeCleaningWorkSnapshot(store, scope)]);
      assert.deepEqual(results.map(r => r.outcome).sort(), ["CREATED", "REPLAYED"]);
      assert.equal(await count(scope), 1);
      assert.equal(results[0].work?.scheduledStartAt.toISOString(), "2026-09-28T15:30:00.000Z");
      assert.equal(results[0].work?.startConfirmedAt, null);
      assert.equal(results[0].work?.completionConfirmedAt, null);
      assert.equal(results[0].timingCommitmentAccepted, false);
    });
    await t.test("different cleaners cannot race into two current jobs for one reservation", async () => {
      const scope = await fixture();
      const other = { ...scope, staffMemberId: `staff-${randomUUID()}`, confirmationId: `confirmation-${randomUUID()}` };
      await addCleaner(other);
      const results = await Promise.allSettled([materializeCleaningWorkSnapshot(store, scope), materializeCleaningWorkSnapshot(store, other)]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      assert.equal(await count(scope), 1);
      const rejected = results.find(r => r.status === "rejected");
      assert.ok(rejected?.status === "rejected");
      assert.equal(rejected.reason.code, "CLEANING_WORK_REASSIGNMENT_REQUIRES_REVIEW");
    });
    await t.test("Staff edits do not overwrite the saved timing snapshot", async () => {
      const scope = await fixture();
      const first = await materializeCleaningWorkSnapshot(store, scope);
      await db.$executeRaw`UPDATE "PropertyStaff" SET "cleaningDurationCommitmentMinutes" = 240 WHERE "staffMemberId" = ${scope.staffMemberId}`;
      const replay = await materializeCleaningWorkSnapshot(store, scope);
      assert.deepEqual(replay.work, first.work);
      assert.equal(replay.work?.durationCommitmentMinutes, 120);
    });
    await t.test("foreign organization and reservation bindings reject with zero writes", async () => {
      const scope = await fixture();
      await assert.rejects(materializeCleaningWorkSnapshot(store, { ...scope, organizationId: "foreign-org" }), /OUT_OF_SCOPE/);
      await assert.rejects(materializeCleaningWorkSnapshot(store, { ...scope, confirmationId: "foreign-confirmation" }), /OUT_OF_SCOPE/);
      assert.equal(await count(scope), 0);
    });
    await t.test("changed checkout is rejected without rewriting existing work", async () => {
      const scope = await fixture();
      const first = await materializeCleaningWorkSnapshot(store, scope);
      await db.$executeRaw`UPDATE "Reservation" SET "checkOut" = TIMESTAMP '2026-09-29 15:00:00' WHERE "id" = ${scope.reservationId}`;
      await assert.rejects(materializeCleaningWorkSnapshot(store, scope), /SCHEDULE_CHANGED/);
      const row = await db.cleaningWork.findUniqueOrThrow({ where: { id: first.work!.id } });
      assert.equal(row.scheduledStartAt.toISOString(), "2026-09-28T15:30:00.000Z");
    });
    await t.test("cancelled work is never reopened", async () => {
      const scope = await fixture();
      const first = await materializeCleaningWorkSnapshot(store, scope);
      await db.cleaningWork.update({ where: { id: first.work!.id }, data: { cancelledAt: new Date() } });
      assert.equal((await materializeCleaningWorkSnapshot(store, scope)).outcome, "EXISTING_CLOSED");
      assert.equal(await count(scope), 1);
    });
    await t.test("NFC-disabled and inactive staff cannot create jobs", async () => {
      const scope = await fixture();
      await db.$executeRaw`UPDATE "Property" SET "cleaningNfcEnabled" = false WHERE "id" = ${scope.propertyId}`;
      await assert.rejects(materializeCleaningWorkSnapshot(store, scope), /NFC_FLOW_DISABLED/);
      await db.$executeRaw`UPDATE "Property" SET "cleaningNfcEnabled" = true WHERE "id" = ${scope.propertyId}`;
      await db.$executeRaw`UPDATE "StaffMember" SET "isActive" = false WHERE "id" = ${scope.staffMemberId}`;
      await assert.rejects(materializeCleaningWorkSnapshot(store, scope), /INACTIVE_CONTEXT/);
      assert.equal(await count(scope), 0);
    });
    await t.test("failed transaction rolls back a created snapshot", async () => {
      const scope = await fixture();
      await assert.rejects(store.transaction(async tx => {
        await tx.loadContext(scope);
        await tx.create({ reservationId: scope.reservationId, propertyId: scope.propertyId,
          staffMemberId: scope.staffMemberId, confirmationId: scope.confirmationId,
          scheduledStartAt: new Date("2026-09-28T15:30:00Z"), durationCommitmentMinutes: 120,
          startConfirmationGraceMinutes: 30, followupGraceMinutes: 15 });
        throw new Error("FORCED_ROLLBACK");
      }), /FORCED_ROLLBACK/);
      assert.equal(await count(scope), 0);
    });
    await t.test("database timing checks reject invalid data", async () => {
      const scope = await fixture();
      await assert.rejects(db.$executeRaw`UPDATE "PropertyStaff" SET "cleaningDurationCommitmentMinutes" = 14 WHERE "staffMemberId" = ${scope.staffMemberId}`);
    });
  } finally {
    await db.$disconnect();
  }
});
