import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { cleanerTaskPageIds } from "./cleaner-task-pagination.service.js";
const url = process.env.CLEANER_ACCOUNT_TEST_DATABASE_URL;
if (url) { const u = new URL(url); if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.pathname !== "/cleaner_account_test") throw new Error("Isolated loopback database required"); }
test("view filter precedes 25-record pagination and respects local day and cleaner ownership", { skip: !url }, async t => {
  const db = new PrismaClient({ datasources: { db: { url: url! } } });
  const id = `page-${randomUUID()}`;
  await db.organization.create({ data: { id, name: "Synthetic pagination" } });
  t.after(async () => { await db.cleaningConfirmation.deleteMany({ where: { propertyId: id } }); await db.reservation.deleteMany({ where: { propertyId: id } }); await db.property.delete({ where: { id } }); await db.staffMember.deleteMany({ where: { organizationId: id } }); await db.organization.delete({ where: { id } }); await db.$disconnect(); });
  await db.property.create({ data: { id, organizationId: id, name: "Synthetic property", timezone: "America/Puerto_Rico" } });
  await db.staffMember.create({ data: { id, organizationId: id, fullName: "Synthetic cleaner" } });
  for (let index = 0; index < 30; index++) {
    const rid = `${id}-z${String(index).padStart(2, "0")}`;
    await db.reservation.create({ data: { id: rid, propertyId: id, guestName: "Synthetic", status: "ACTIVE", checkIn: new Date("2026-11-01T20:00:00Z"), checkOut: new Date("2026-11-02T16:00:00Z") } });
    await db.cleaningConfirmation.create({ data: { id: rid, reservationId: rid, propertyId: id, staffMemberId: id, token: randomUUID(), status: "CONFIRMED" } });
  }
  for (const [suffix, departure, status] of [["a-today", "2026-10-08T03:00:00Z", "CONFIRMED"], ["a-overdue", "2026-10-06T16:00:00Z", "CONFIRMED"], ["a-closed", "2026-10-06T16:00:00Z", "CANCELLED"]]) {
    const rid = `${id}-${suffix}`;
    await db.reservation.create({ data: { id: rid, propertyId: id, guestName: "Synthetic", status: "ACTIVE", checkIn: new Date("2026-10-01T20:00:00Z"), checkOut: new Date(departure!) } });
    await db.cleaningConfirmation.create({ data: { id: rid, reservationId: rid, propertyId: id, staffMemberId: id, token: randomUUID(), status: status! } });
  }
  const input = { staffMemberId: id, organizationId: id, now: new Date("2026-10-08T02:00:00Z"), limit: 26 };
  assert.deepEqual(await cleanerTaskPageIds(db, { ...input, view: "today" }), [`${id}-a-today`, `${id}-a-overdue`]);
  const first = await cleanerTaskPageIds(db, { ...input, view: "upcoming" }); assert.equal(first.length, 26);
  const second = await cleanerTaskPageIds(db, { ...input, view: "upcoming", cursor: first[24] }); assert.equal(second.length, 5);
  assert.equal(new Set([...first.slice(0, 25), ...second]).size, 30);
  assert.deepEqual(await cleanerTaskPageIds(db, { ...input, view: "history" }), [`${id}-a-closed`]);
  assert.deepEqual(await cleanerTaskPageIds(db, { ...input, view: "today", organizationId: "foreign" }), []);
  assert.deepEqual(await cleanerTaskPageIds(db, { ...input, view: "today", staffMemberId: "foreign" }), []);
});
