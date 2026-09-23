import assert from "node:assert/strict";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  findDamageCaseMissionControlReconciliationCandidates as candidates,
  reconcileDamageCaseMissionControl as reconcile,
} from "./damage-case-mission-control-reconciliation.service.js";

// Deliberately no DATABASE_URL fallback and no dotenv/server/worker imports.
// This exact loopback database belongs to the disposable CI service only.
const TEST_URL = "postgresql://postgres:postgres@127.0.0.1:5432/pingo_pp_reconciliation_test";
const HOST_NOTICE = "PROPERTY_PROTECTION_HOST_GUEST_RESPONSE_NOTICE";
const CLOSURE_NOTICE = "PROPERTY_PROTECTION_GUEST_NO_CHARGE_CLOSURE_NOTICE";

test("PostgreSQL reconciliation: canonical projection, tenant scope and idempotency", async (t) => {
  assert.equal(process.env.PROPERTY_PROTECTION_TEST_DATABASE_URL, TEST_URL,
    "Refusing database access: explicit disposable test URL required");
  const db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
  t.after(() => db.$disconnect());
  // Fail rather than reset or delete an existing database's records.
  for (const count of await Promise.all([
    db.organization.count(), db.damageCase.count(), db.messageLog.count(),
    db.operationalIssue.count(),
  ])) assert.equal(count, 0, "Disposable database must start empty");

  let sequence = 0;
  async function fixture(overrides: Partial<Prisma.DamageCaseUncheckedCreateInput> = {}) {
    const name = `synthetic-${++sequence}`;
    const org = await db.organization.create({ data: { name } });
    const property = await db.property.create({ data: { organizationId: org.id, name } });
    const reservation = await db.reservation.create({ data: {
      propertyId: property.id, guestName: "Synthetic guest", guestEmail: `${name}@example.invalid`,
      checkIn: new Date("2026-01-01T16:00:00Z"), checkOut: new Date("2026-01-02T11:00:00Z"),
    } });
    const damageCase = await db.damageCase.create({ data: {
      reservationId: reservation.id, requestedAmount: 10, description: "Synthetic evidence only",
      status: "GUEST_NOTIFIED", guestResponse: "ACCEPTED", guestNotifiedAt: new Date("2026-01-03T00:00:00Z"),
      ...overrides,
    } });
    const email = `${name}-admin@example.invalid`;
    await db.dashboardUser.create({ data: {
      organizationId: org.id, email, passwordHash: "not-a-login-hash", role: "ORG_ADMIN",
    } });
    return { org, property, reservation, damageCase, email };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function message(f: Fixture, status: string | null, retryCount = 0,
    extra: Partial<Prisma.MessageLogUncheckedCreateInput> = {}) {
    return db.messageLog.create({ data: {
      organizationId: f.org.id, propertyId: f.property.id, reservationId: f.reservation.id,
      channel: "email", to: f.email, provider: "synthetic-only", body: "No delivery invoked",
      communicationType: HOST_NOTICE, status, retryCount, ...extra,
    } });
  }
  const issue = (f: Fixture) => db.operationalIssue.findUniqueOrThrow({
    where: { operationalKey: `PROPERTY_PROTECTION_DAMAGE_CASE:${f.damageCase.id}` },
  });
  async function settle(f: Fixture, state: string, metadata: Record<string, unknown> = {}, maxRetries = 3) {
    const before = await Promise.all([
      db.damageCase.findMany({ orderBy: { id: "asc" } }),
      db.reservation.findMany({ orderBy: { id: "asc" } }),
      db.messageLog.findMany({ orderBy: { id: "asc" } }),
    ]);
    assert.deepEqual(await reconcile({ prisma: db, batchSize: 20, maxMessageRetries: maxRetries }),
      { checked: 1, reconciled: 1, failed: 0 });
    const result = await issue(f);
    assert.equal(result.workflowState, state);
    assert.equal(result.organizationId, f.org.id);
    assert.equal(result.propertyId, f.property.id);
    assert.equal(result.reservationId, f.reservation.id);
    for (const [key, value] of Object.entries(metadata)) {
      assert.deepEqual((result.metadata as Record<string, unknown>)[key], value, key);
    }
    const transitions = await db.operationalIssueTransition.count();
    assert.deepEqual(await candidates(db, 20, maxRetries), []);
    assert.deepEqual(await reconcile({ prisma: db, batchSize: 20, maxMessageRetries: maxRetries }),
      { checked: 0, reconciled: 0, failed: 0 });
    assert.deepEqual(await issue(f), result, "Second tick must not write the issue");
    assert.equal(await db.operationalIssueTransition.count(), transitions, "No duplicate transitions");
    assert.deepEqual(await Promise.all([
      db.damageCase.findMany({ orderBy: { id: "asc" } }),
      db.reservation.findMany({ orderBy: { id: "asc" } }),
      db.messageLog.findMany({ orderBy: { id: "asc" } }),
    ]), before, "Reconciliation must not mutate canonical cases, reservations or messages");
  }

  await t.test("missing projection and repeated ticks", async () => {
    const f = await fixture({ status: "OPEN", guestResponse: "PENDING", guestNotifiedAt: null });
    await settle(f, "ACTION_REQUIRED", { hostResponseDeliveryStatus: "NOT_REQUIRED" });
  });

  await t.test("host delivery: missing, retrying, exhausted, null and sent", async () => {
    const f = await fixture();
    await settle(f, "ACTION_REQUIRED", { hostResponseDeliveryStatus: "MISSING" });
    const log = await message(f, "FAILED", 1);
    await settle(f, "AUTO_RESOLVING", { hostResponseDeliveryStatus: "RETRYING" });
    await db.messageLog.update({ where: { id: log.id }, data: { retryCount: 3 } });
    await settle(f, "ACTION_REQUIRED", { hostResponseDeliveryStatus: "FAILED_FINAL" });
    await db.messageLog.update({ where: { id: log.id }, data: { status: "SENT" } });
    await settle(f, "WAITING", { hostResponseDeliveryStatus: "SENT" });
    await db.messageLog.update({ where: { id: log.id }, data: { status: null } });
    await settle(f, "ACTION_REQUIRED", { hostResponseFailedFinalCount: 1 });
    await db.messageLog.update({ where: { id: log.id }, data: { status: "SENT" } });
    await settle(f, "WAITING", { hostResponseDeliveryStatus: "SENT" });
  });

  await t.test("normalizes and deduplicates admins; excludes inactive recipients", async () => {
    const f = await fixture();
    await db.dashboardUser.createMany({ data: [
      { organizationId: f.org.id, email: ` ${f.email.toUpperCase()} `, passwordHash: "synthetic" },
      { organizationId: f.org.id, email: `inactive-${f.email}`, passwordHash: "synthetic", isActive: false },
    ] });
    await message(f, "SENT", 0, { to: ` ${f.email.toUpperCase()} ` });
    await settle(f, "WAITING", { hostResponseRecipientCount: 1, hostResponseSentCount: 1 });
    await db.dashboardUser.updateMany({ where: { organizationId: f.org.id }, data: { isActive: false } });
    await settle(f, "ACTION_REQUIRED", { hostResponseDeliveryStatus: "DESTINATION_MISSING" });
  });

  await t.test("latest host log tie-break and custom retry limit agree with projector", async () => {
    const f = await fixture();
    const createdAt = new Date("2026-01-04T00:00:00Z");
    await message(f, "SENT", 0, { id: "synthetic-tie-a", createdAt });
    const log = await message(f, "FAILED", 2, { id: "synthetic-tie-z", createdAt });
    await settle(f, "AUTO_RESOLVING", { hostResponseDeliveryStatus: "RETRYING" });
    await settle(f, "ACTION_REQUIRED", { hostResponseDeliveryStatus: "FAILED_FINAL" }, 2.9);
    await db.messageLog.update({ where: { id: log.id }, data: { status: "SENT" } });
    await settle(f, "WAITING", { hostResponseDeliveryStatus: "SENT" });
  });

  await t.test("initial guest notice retry evidence changes without case mutation", async () => {
    const f = await fixture({ status: "GUEST_NOTIFICATION_PENDING", guestResponse: "PENDING", guestNotifiedAt: null });
    const log = await message(f, "FAILED", 1, { communicationType: "PROPERTY_PROTECTION_GUEST_DAMAGE_NOTICE" });
    await settle(f, "AUTO_RESOLVING", { damageNoticeRetryCount: 1 });
    await db.messageLog.update({ where: { id: log.id }, data: { status: "FAILED_FINAL", retryCount: 3 } });
    await settle(f, "ACTION_REQUIRED", { damageNoticeDeliveryStatus: "FAILED_FINAL" });
  });

  await t.test("rejects foreign host message scope and repairs issue scope", async () => {
    const other = await fixture({ status: "OPEN", guestResponse: "PENDING", guestNotifiedAt: null });
    await settle(other, "ACTION_REQUIRED");
    const f = await fixture();
    await message(f, "SENT", 0, { organizationId: other.org.id });
    await message(f, "SENT", 0, { propertyId: other.property.id });
    await message(f, "SENT", 0, { reservationId: other.reservation.id });
    await settle(f, "ACTION_REQUIRED", { hostResponseMissingCount: 1 });
    await db.operationalIssue.update({ where: { id: (await issue(f)).id }, data: {
      organizationId: other.org.id, propertyId: other.property.id, reservationId: other.reservation.id,
    } });
    await settle(f, "ACTION_REQUIRED");
  });

  await t.test("all recipients must receive notice; disputes remain actionable", async () => {
    const f = await fixture({ guestResponse: "DISPUTED" });
    const second = `second-${f.email}`;
    await db.dashboardUser.create({ data: { organizationId: f.org.id, email: second, passwordHash: "synthetic" } });
    await message(f, "SENT");
    const log = await message(f, "FAILED", 1, { to: second });
    await settle(f, "ACTION_REQUIRED", { hostResponseDeliveryStatus: "RETRYING", hostResponseRecipientCount: 2 });
    await db.messageLog.update({ where: { id: log.id }, data: { status: "SENT" } });
    await settle(f, "ACTION_REQUIRED", { hostResponseDeliveryStatus: "SENT", hostResponseSentCount: 2 });
  });

  await t.test("closure resolves only with delivery and reopens on stale delivery", async () => {
    const f = await fixture({ status: "CLOSED_NO_CHARGE", guestResponse: "PENDING", closedReason: "Synthetic closure" });
    const log = await message(f, "FAILED", 1, { communicationType: CLOSURE_NOTICE });
    await settle(f, "AUTO_RESOLVING");
    await db.messageLog.update({ where: { id: log.id }, data: { status: "SENT" } });
    await settle(f, "RESOLVED");
    // Synthetic stale-resolution scenario, not an actual delivery or retry.
    await db.messageLog.update({ where: { id: log.id }, data: { status: "FAILED_FINAL" } });
    await settle(f, "ACTION_REQUIRED");
    assert.equal((await issue(f)).reopenedCount, 1);
  });

  await t.test("bounded deterministic batches do not starve remaining cases", async () => {
    const first = await fixture({ status: "OPEN", guestResponse: "PENDING", guestNotifiedAt: null });
    const second = await fixture({ status: "OPEN", guestResponse: "PENDING", guestNotifiedAt: null });
    const sameTime = new Date("2026-01-01T00:00:00Z");
    await db.damageCase.updateMany({ where: { id: { in: [first.damageCase.id, second.damageCase.id] } }, data: { updatedAt: sameTime } });
    const ids = [first.damageCase.id, second.damageCase.id].sort();
    assert.deepEqual(await candidates(db, 1, 3), [{ damageCaseId: ids[0] }]);
    assert.deepEqual(await reconcile({ prisma: db, batchSize: 1, maxMessageRetries: 3 }), { checked: 1, reconciled: 1, failed: 0 });
    assert.deepEqual(await candidates(db, 1, 3), [{ damageCaseId: ids[1] }]);
    await settle(first.damageCase.id === ids[1] ? first : second, "ACTION_REQUIRED");
  });
});
