import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { listHostCleanings, parseHostCleaningFilters } from "./host-cleanings.service.js";
const url = process.env.CLEANER_ACCOUNT_TEST_DATABASE_URL;
if (url) { const u = new URL(url); if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.pathname !== "/cleaner_account_test") throw new Error("Isolated loopback database required"); }
test("invalid views, statuses and repeated filters are rejected", () => {
  for (const q of [{ view: "other" }, { status: "wrong" }, { propertyId: ["a", "b"] }, { cursor: "a".repeat(201) }]) assert.throws(() => parseHostCleaningFilters(q));
});
test("host timeline is tenant scoped, paginated after filtering, local-time correct and read-only", { skip: !url }, async t => {
  const db = new PrismaClient({ datasources: { db: { url: url! } } });
  const id = `host-${randomUUID()}`, other = `${id}-other`;
  const orgs = [id, other];
  t.after(async () => {
    await db.cleaningWork.deleteMany({ where: { propertyId: { in: orgs } } });
    await db.cleaningConfirmation.deleteMany({ where: { propertyId: { in: orgs } } });
    await db.reservation.deleteMany({ where: { propertyId: { in: orgs } } });
    await db.property.deleteMany({ where: { id: { in: orgs } } });
    await db.staffMember.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.$disconnect();
  });
  for (const org of orgs) {
    await db.organization.create({ data: { id: org, name: "Synthetic host" } });
    await db.property.create({ data: { id: org, organizationId: org, name: "Synthetic property", timezone: "America/Puerto_Rico", cleaningStartOffsetMinutes: 10 } });
    await db.staffMember.create({ data: { id: org, organizationId: org, fullName: "Synthetic cleaner" } });
  }
  for (let i = 0; i < 53; i++) {
    const rid = `${id}-${String(i).padStart(2, "0")}`;
    await db.reservation.create({ data: { id: rid, propertyId: id, guestName: "Synthetic", checkIn: new Date("2026-10-01T20:00Z"), checkOut: new Date("2026-10-08T02:00Z"), status: "ACTIVE" } });
    await db.cleaningConfirmation.create({ data: { id: rid, reservationId: rid, propertyId: id, staffMemberId: id, token: randomUUID(), status: "CONFIRMED" } });
  }
  const rid = `${id}-00`;
  await db.cleaningWork.create({ data: { reservationId: rid, propertyId: id, staffMemberId: id, confirmationId: rid, scheduledStartAt: new Date("2026-10-08T02:10Z"), durationCommitmentMinutes: 30, startConfirmationGraceMinutes: 10, followupGraceMinutes: 15, startConfirmedAt: new Date("2026-10-08T02:12Z"), completionConfirmedAt: new Date("2026-10-08T02:39Z") } });
  const now = new Date("2026-10-08T03:00Z");
  const first = await listHostCleanings(db, id, parseHostCleaningFilters({ view: "today" }), now);
  assert.equal(first.items.length, 50); assert.ok(first.nextCursor);
  const second = await listHostCleanings(db, id, parseHostCleaningFilters({ view: "today", cursor: first.nextCursor }), now);
  assert.equal(second.items.length, 3); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(i => i.id)).size, 53);
  const history = await listHostCleanings(db, id, parseHostCleaningFilters({ view: "history" }), now);
  assert.equal(history.items.length, 1); assert.equal(history.items[0]?.actualDurationMinutes, 27);
  assert.equal(history.items[0]?.committedEndAt?.toISOString(), "2026-10-08T02:40:00.000Z");
  assert.equal(history.items[0]?.status, "COMPLETED");
  assert.equal(JSON.stringify(history).includes('"token"'), false);
  assert.equal((await listHostCleanings(db, other, parseHostCleaningFilters({ view: "all", propertyId: id }), now)).items.length, 0);
  assert.deepEqual(history.properties.map(p => p.id), [id]); assert.deepEqual(history.staff.map(s => s.id), [id]);
  assert.equal((await listHostCleanings(db, id, parseHostCleaningFilters({ view: "today" }), new Date("2026-10-08T05:00Z"))).items.length, 0);
  assert.equal((await listHostCleanings(db, id, parseHostCleaningFilters({ view: "all", status: "COMPLETED", reservationId: rid }), now)).items.length, 1);
  assert.equal((await listHostCleanings(db, id, parseHostCleaningFilters({ view: "all", staffMemberId: other }), now)).items.length, 0);
});
