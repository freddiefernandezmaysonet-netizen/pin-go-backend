import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { requestCleanerAccount, issueCleanerActivation, activateCleanerAccount, loadCleanerActivation } from "./cleaner-account.service.js";

// Explicit opt-in: never reuse DATABASE_URL or connect to a hosted database.
const databaseUrl = process.env.CLEANER_ACCOUNT_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/cleaner_account_test") {
    throw new Error("Use an isolated loopback database named cleaner_account_test");
  }
}

test("cleaner account lifecycle against an isolated SQL database", { skip: !databaseUrl }, async t => {
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
  const id = `cleaner-test-${randomUUID()}`;
  const now = new Date();
  const email = `${id}@example.com`;
  await db.organization.create({ data: { id, name: "Synthetic cleaner account test" } });
  t.after(async () => {
    await db.cleaningWork.deleteMany({ where: { propertyId: id } });
    await db.cleaningConfirmation.deleteMany({ where: { propertyId: id } });
    await db.reservation.deleteMany({ where: { propertyId: id } });
    await db.property.deleteMany({ where: { id } });
    await db.staffMember.deleteMany({ where: { organizationId: id } });
    await db.dashboardUser.deleteMany({ where: { organizationId: id } });
    await db.organization.delete({ where: { id } });
    await db.$disconnect();
  });
  await db.property.create({ data: { id, organizationId: id, name: "Synthetic property" } });
  await db.staffMember.create({ data: { id, organizationId: id, fullName: "Synthetic Cleaner", preferredLanguage: "es", ttlockCardRef: "synthetic-card" } });
  await db.reservation.create({ data: { id, propertyId: id, guestName: "Synthetic guest", status: "ACTIVE", checkIn: now, checkOut: new Date(now.getTime() + 86400000) } });
  await db.cleaningConfirmation.create({ data: { id, propertyId: id, reservationId: id, staffMemberId: id, token: randomUUID(), status: "PENDING" } });
  await db.cleaningWork.create({ data: { propertyId: id, reservationId: id, staffMemberId: id, confirmationId: id, scheduledStartAt: now, durationCommitmentMinutes: 90, startConfirmationGraceMinutes: 30, followupGraceMinutes: 15 } });
  await db.staffAssignment.create({ data: { reservationId: id, staffMemberId: id, startsAt: now, endsAt: new Date(now.getTime() + 14400000) } });
  const workBefore = await db.cleaningWork.findFirst({ where: { confirmationId: id } });
  const accessBefore = await db.staffAssignment.findFirst({ where: { reservationId: id } });

  await t.test("host preparation is idempotent and cannot cross organizations", async () => {
    await assert.rejects(requestCleanerAccount(db, "foreign-org", id, email, now), /STAFF_NOT_FOUND/);
    await requestCleanerAccount(db, id, id, email, now);
    await requestCleanerAccount(db, id, id, email.toUpperCase(), new Date(now.getTime() + 1000));
    assert.equal((await db.staffMember.findUniqueOrThrow({ where: { id } })).cleanerAccountRequestedAt?.getTime(), now.getTime());
    assert.equal(await db.dashboardUser.count({ where: { organizationId: id } }), 0);
  });

  await t.test("changing email invalidates old capabilities; expired capabilities cannot activate", async () => {
    const old = await issueCleanerActivation(db, id, now);
    assert.ok(old);
    await requestCleanerAccount(db, id, id, `changed-${email}`, new Date(now.getTime() + 1));
    await assert.rejects(loadCleanerActivation(db, old, now), /ACTIVATION_INVALID/);
    await requestCleanerAccount(db, id, id, email, new Date(now.getTime() + 2));
    const expired = await issueCleanerActivation(db, id, new Date(now.getTime() - 49 * 3600000));
    assert.ok(expired);
    await assert.rejects(activateCleanerAccount(db, expired, email, "IndependentCleaning!83", now), /ACTIVATION_INVALID/);
  });

  await t.test("activation consumes every capability and preserves work, access, language and NFC", async () => {
    const token = await issueCleanerActivation(db, id, now);
    const other = await issueCleanerActivation(db, id, now);
    assert.ok(token && other);
    await assert.rejects(activateCleanerAccount(db, token, `wrong-${email}`, "IndependentCleaning!83", now), /EMAIL_MISMATCH/);
    await activateCleanerAccount(db, token, email, "IndependentCleaning!83", now);
    const staff = await db.staffMember.findUniqueOrThrow({ where: { id } });
    const user = await db.dashboardUser.findUniqueOrThrow({ where: { id: staff.dashboardUserId! } });
    assert.equal(user.role, "CLEANER");
    assert.equal(user.organizationId, id);
    assert.equal(staff.preferredLanguage, "es");
    assert.equal(staff.ttlockCardRef, "synthetic-card");
    assert.deepEqual(await db.cleaningWork.findFirst({ where: { confirmationId: id } }), workBefore);
    assert.deepEqual(await db.staffAssignment.findFirst({ where: { reservationId: id } }), accessBefore);
    await assert.rejects(activateCleanerAccount(db, other, email, "IndependentCleaning!83", now), /ACTIVATION_INVALID/);
    assert.equal(await db.cleanerAccountActivation.count({ where: { staffMemberId: id, consumedAt: null } }), 0);
    assert.equal(await db.dashboardUser.count({ where: { email } }), 1);
  });

  await t.test("SQL enforces unique user links and foreign keys", async () => {
    const staff = await db.staffMember.findUniqueOrThrow({ where: { id } });
    await assert.rejects(db.staffMember.create({ data: { organizationId: id, fullName: "Second synthetic cleaner", dashboardUserId: staff.dashboardUserId } }), (error: any) => error.code === "P2002");
    // PGlite's wire bridge closes connections after SQL errors. Reconnect so
    // this constraint check also runs there; native PostgreSQL needs no retry.
    await db.$disconnect();
    await db.$connect();
    await assert.rejects(db.staffMember.update({ where: { id }, data: { dashboardUserId: "nonexistent-user" } }), (error: any) => error.code === "P2003");
    await db.$disconnect();
    await db.$connect();
    assert.equal((await db.staffMember.findUniqueOrThrow({ where: { id } })).dashboardUserId, staff.dashboardUserId);
  });
});
