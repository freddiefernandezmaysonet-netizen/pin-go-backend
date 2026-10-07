import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { confirmCleaningStart } from "./cleaning-work-start.prisma.js";
import { confirmCleaningCompletion } from "./cleaning-work-completion.prisma.js";
const databaseUrl = process.env.CLEANER_ACCOUNT_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/cleaner_account_test") throw new Error("Use an isolated loopback cleaner_account_test database");
}
test("work action bounds and independent access against isolated SQL", { skip: !databaseUrl }, async t => {
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
  const id = `cleaning-window-test-${randomUUID()}`;
  const at = (time: string) => new Date(`2030-01-01T${time}Z`);
  await db.organization.create({ data: { id, name: "Synthetic timing test" } });
  t.after(async () => {
    await db.cleaningWork.deleteMany({ where: { propertyId: id } });
    await db.cleaningConfirmation.deleteMany({ where: { propertyId: id } });
    await db.reservation.deleteMany({ where: { propertyId: id } });
    await db.property.delete({ where: { id } });
    await db.staffMember.delete({ where: { id } });
    await db.organization.delete({ where: { id } });
    await db.$disconnect();
  });
  await db.property.create({ data: { id, organizationId: id, name: "Synthetic timing property", status: "ACTIVE", checkOutTime: "11:00", checkInTime: "16:00", timezone: "America/Puerto_Rico", cleaningStartOffsetMinutes: 30 } });
  await db.staffMember.create({ data: { id, organizationId: id, fullName: "Synthetic cleaner", ttlockCardRef: "synthetic-card" } });
  await db.propertyStaff.create({ data: { propertyId: id, staffMemberId: id, role: "PRIMARY", cleaningDurationCommitmentMinutes: 120 } });
  await db.reservation.create({ data: { id, propertyId: id, guestName: "Synthetic departure", status: "ACTIVE", checkIn: new Date("2029-12-30T20:00Z"), checkOut: at("15:00") } });
  await db.reservation.create({ data: { id: `${id}-arrival`, propertyId: id, guestName: "Synthetic arrival", status: "ACTIVE", checkIn: at("20:00"), checkOut: new Date("2030-01-03T15:00Z") } });
  await db.cleaningConfirmation.create({ data: { id, reservationId: id, propertyId: id, staffMemberId: id, status: "CONFIRMED", token: randomUUID() } });
  const work = await db.cleaningWork.create({ data: { reservationId: id, propertyId: id, staffMemberId: id, confirmationId: id, scheduledStartAt: at("15:30"), durationCommitmentMinutes: 120, startConfirmationGraceMinutes: 30, followupGraceMinutes: 15, timingConsentVersion: "cleaning_timing_v1", timingConsentAcceptedAt: at("14:00") } });
  await db.staffAssignment.create({ data: { reservationId: id, staffMemberId: id, startsAt: at("15:30"), endsAt: at("19:30"), status: "COMPLETED" } });
  const accessBefore = await db.staffAssignment.findFirst({ where: { reservationId: id } });
  const input = { workId: work.id, reservationId: id, staffMemberId: id, confirmationId: id };
  await t.test("early start and completion without start leave work unchanged", async () => {
    await assert.rejects(confirmCleaningStart(db, input, at("15:29")), /TOO_EARLY/);
    await assert.rejects(confirmCleaningCompletion(db, input, at("16:00")), /START_REQUIRED/);
    const current = await db.cleaningWork.findUniqueOrThrow({ where: { id: work.id } });
    assert.equal(current.startConfirmedAt, null);
    assert.equal(current.completionConfirmedAt, null);
  });
  await t.test("start records only work; NFC expiry never records completion", async () => {
    await confirmCleaningStart(db, input, at("15:30"));
    assert.equal((await db.cleaningWork.findUniqueOrThrow({ where: { id: work.id } })).completionConfirmedAt, null);
    assert.deepEqual(await db.staffAssignment.findFirst({ where: { reservationId: id } }), accessBefore);
  });
  await t.test("completion at closure with an arrival is rejected without writing", async () => {
    await assert.rejects(confirmCleaningCompletion(db, input, at("19:30")), /WINDOW_CLOSED/);
    assert.equal((await db.cleaningWork.findUniqueOrThrow({ where: { id: work.id } })).completionConfirmedAt, null);
  });
  await t.test("without an arrival late completion succeeds and leaves access/NFC unchanged", async () => {
    await db.reservation.delete({ where: { id: `${id}-arrival` } });
    const result = await confirmCleaningCompletion(db, input, at("22:00"));
    assert.equal(result.completionConfirmedAt?.getTime(), at("22:00").getTime());
    assert.deepEqual(await db.staffAssignment.findFirst({ where: { reservationId: id } }), accessBefore);
    assert.equal((await db.staffMember.findUniqueOrThrow({ where: { id } })).ttlockCardRef, "synthetic-card");
  });
});
