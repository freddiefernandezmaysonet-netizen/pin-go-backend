import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { recordChannexAvailabilityConflict } from "./channex-availability-conflict.service";
import { readAvailabilityConflictReview, resolveAvailabilityConflictReview } from "./ota-availability-conflict-review.service";

const url = process.env.STAY_TIME_TEST_DATABASE_URL;
test("host reviews OTA conflicts in disposable PostgreSQL", { skip: !url }, async t => {
  const parsed = new URL(url!);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname));
  assert.equal(parsed.pathname, "/pingo_stay_time_test");
  const db = new PrismaClient({ datasources: { db: { url } } });
  const org = await db.organization.create({ data: { name: "Synthetic OTA conflict review" } });
  const property = await db.property.create({ data: { organizationId: org.id, name: "Synthetic property", timezone: "America/Puerto_Rico" } });
  t.after(async () => {
    try {
      await db.operationalIssue.deleteMany({ where: { propertyId: property.id } });
      await db.reservationModification.deleteMany({ where: { reservation: { propertyId: property.id } } });
      await db.reservation.deleteMany({ where: { propertyId: property.id } });
      await db.propertyBlockedDate.deleteMany({ where: { propertyId: property.id } });
      await db.property.delete({ where: { id: property.id } });
      await db.organization.delete({ where: { id: org.id } });
    } finally { await db.$disconnect(); }
  });
  const user = await db.dashboardUser.create({ data: { organizationId: org.id, email: `${org.id}@synthetic.invalid`, passwordHash: "synthetic", role: "ORG_ADMIN" } });
  const actor = { id: user.id, orgId: org.id };
  const other = await db.reservation.create({ data: { propertyId: property.id, guestName: "Existing synthetic guest",
    checkIn: new Date("2026-11-01T19:00Z"), checkOut: new Date("2026-11-04T15:00Z"), source: "MANUAL" } });
  const incoming = await db.reservation.create({ data: { propertyId: property.id, guestName: "OTA synthetic guest", externalProvider: "CHANNEX",
    checkIn: new Date("2026-11-03T19:00Z"), checkOut: new Date("2026-11-06T15:00Z"), source: "AIRBNB" } });
  const detect = (revision: string) => db.$transaction(tx => recordChannexAvailabilityConflict(tx, { reservationId: incoming.id, revision }));
  const first = (await detect("review-1"))!;
  const original = await db.reservation.findMany({ where: { propertyId: property.id }, orderBy: { id: "asc" } });
  const command = { expectedUpdatedAt: first.updatedAt.toISOString(), resolutionSummary: "Host coordinated accommodation with both guests and the OTA." };
  await t.test("read exposes scoped reservation numbers, captured cause and live availability without technical metadata", async () => {
    const result = await readAvailabilityConflictReview(db, actor, incoming.id);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]!.detectedCause.reservation?.id, other.id);
    assert.equal(result.items[0]!.detectedCause.reservation?.reservationNumber, other.reservationNumber);
    assert.equal(result.currentAvailability?.available, false);
    assert.equal(result.reservation.property.timezone, "America/Puerto_Rico");
    assert.equal(result.items[0]!.history.length, 1);
    assert.ok(!JSON.stringify(result).includes(first.operationalKey));
    assert.ok(!JSON.stringify(result).includes("synthetic.invalid"));
  });
  await t.test("cross-tenant, inactive and staff users cannot read or resolve", async () => {
    await assert.rejects(readAvailabilityConflictReview(db, { ...actor, orgId: "other-tenant" }, incoming.id), /FORBIDDEN/);
    await db.dashboardUser.update({ where: { id: actor.id }, data: { isActive: false } });
    await assert.rejects(resolveAvailabilityConflictReview(db, actor, first.id, command), /FORBIDDEN/);
    await db.dashboardUser.update({ where: { id: actor.id }, data: { isActive: true, role: "MEMBER" } });
    await assert.rejects(readAvailabilityConflictReview(db, actor, incoming.id), /FORBIDDEN/);
    await db.dashboardUser.update({ where: { id: actor.id }, data: { role: "PLATFORM_ADMIN" } });
    await assert.rejects(readAvailabilityConflictReview(db, actor, "other-reservation"), /NOT_FOUND/);
  });
  await t.test("stale expected state, wrong issue type and wrong property are rejected without transitions", async () => {
    await assert.rejects(resolveAvailabilityConflictReview(db, actor, first.id, { ...command, expectedUpdatedAt: new Date(0).toISOString() }), /STALE/);
    await db.operationalIssue.update({ where: { id: first.id }, data: { engine: "PIN_AI_GUEST_INCIDENT" } });
    await assert.rejects(resolveAvailabilityConflictReview(db, actor, first.id, command), /NOT_FOUND/);
    await db.operationalIssue.update({ where: { id: first.id }, data: { engine: "Reservation", propertyId: "wrong-property" } });
    await assert.rejects(resolveAvailabilityConflictReview(db, actor, first.id, command), /NOT_FOUND/);
    await db.operationalIssue.update({ where: { id: first.id }, data: { propertyId: property.id } });
    assert.equal(await db.operationalIssueTransition.count({ where: { issueId: first.id } }), 1);
  });
  await t.test("concurrent same-command closure is idempotent with one audited transition", async () => {
    const fresh = await db.operationalIssue.findUniqueOrThrow({ where: { id: first.id } });
    command.expectedUpdatedAt = fresh.updatedAt.toISOString();
    const results = await Promise.all([resolveAvailabilityConflictReview(db, actor, first.id, command), resolveAvailabilityConflictReview(db, actor, first.id, command)]);
    assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]);
    const resolved = await db.operationalIssue.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(resolved.workflowState, "RESOLVED");
    assert.equal(resolved.resolutionType, "MANUAL");
    assert.equal(resolved.resolutionCode, "HOST_REPORTED_RESOLVED");
    assert.equal(resolved.actionRequired, false);
    assert.equal(await db.operationalIssueTransition.count({ where: { issueId: first.id } }), 2);
    assert.deepEqual(await db.reservation.findMany({ where: { propertyId: property.id }, orderBy: { id: "asc" } }), original);
    assert.equal((await detect("review-1"))!.workflowState, "RESOLVED");
  });
  await t.test("different closure cannot overwrite outcome; history remains visible while the overlap still exists", async () => {
    await assert.rejects(resolveAvailabilityConflictReview(db, actor, first.id, { ...command, resolutionSummary: "Different result" }), /ALREADY_RESOLVED/);
    const result = await readAvailabilityConflictReview(db, actor, incoming.id);
    assert.equal(result.items[0]!.state, "RESOLVED");
    assert.equal(result.items[0]!.history[1]!.summary, command.resolutionSummary);
    assert.equal(result.currentAvailability?.available, false);
    assert.equal(result.resolutionMeaning, "HOST_REPORTED_RESOLVED");
  });
  await t.test("a new OTA revision has separate review and simultaneous different outcomes have one winner", async () => {
    const renewed = (await detect("review-2"))!;
    assert.notEqual(renewed.id, first.id);
    const input = { ...command, expectedUpdatedAt: renewed.updatedAt.toISOString() };
    const results = await Promise.allSettled([resolveAvailabilityConflictReview(db, actor, renewed.id, input),
      resolveAvailabilityConflictReview(db, actor, renewed.id, { ...input, resolutionSummary: "Another host outcome" })]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(await db.operationalIssueTransition.count({ where: { issueId: renewed.id } }), 2);
  });
  await t.test("captured evidence survives a cleared overlap and never links an entity from another property", async () => {
    await db.reservation.update({ where: { id: other.id }, data: { status: "CANCELLED" } });
    const clear = await readAvailabilityConflictReview(db, actor, incoming.id);
    assert.equal(clear.currentAvailability?.available, true);
    assert.equal(clear.items.find(i => i.id === first.id)!.detectedCause.reservation?.id, other.id);
    await db.operationalIssue.update({ where: { id: first.id }, data: { metadata: { version: "channex_availability_conflict_v1",
      conflict: { type: "RESERVATION", id: "foreign-reservation", checkIn: incoming.checkIn.toISOString(), checkOut: incoming.checkOut.toISOString() } } } });
    const safe = await readAvailabilityConflictReview(db, actor, incoming.id);
    assert.equal(safe.items.find(i => i.id === first.id)!.detectedCause.reservation, null);
    assert.ok(!JSON.stringify(safe).includes("foreign-reservation"));
  });
  await t.test("blocked-date cause is scoped and preserves the recorded interval", async () => {
    const block = await db.propertyBlockedDate.create({ data: { propertyId: property.id, startDate: incoming.checkIn, endDate: incoming.checkOut, reason: "Synthetic maintenance" } });
    const blocked = (await detect("blocked-review"))!;
    const result = await readAvailabilityConflictReview(db, actor, incoming.id);
    const cause = result.items.find(i => i.id === blocked.id)!.detectedCause;
    assert.equal(cause.type, "BLOCKED_DATE");
    assert.equal(cause.blockReason, block.reason);
    assert.equal(cause.startsAt, incoming.checkIn.toISOString());
  });
  await t.test("pending-change and cleaning causes resolve only their scoped parent reservation", async () => {
    const modification = await db.reservationModification.create({ data: { reservationId: other.id, clientRequestId: "synthetic-review",
      requestFingerprint: "synthetic", status: "CANCELLED", financialAction: "NO_PAYMENT_REQUIRED", baseReservationUpdatedAt: other.updatedAt,
      currentCheckIn: other.checkIn, currentCheckOut: other.checkOut, proposedCheckIn: other.checkIn, proposedCheckOut: other.checkOut,
      currentAdults: 1, currentChildren: 0, proposedAdults: 1, proposedChildren: 0, currentPricing: {}, proposedPricing: {},
      currentTotalAmount: 0, proposedTotalAmount: 0, amountDifference: 0 } });
    for (const type of ["RESERVATION_MODIFICATION_HOLD", "STAY_TIME_TURNOVER_HOLD"]) {
      await db.operationalIssue.update({ where: { id: first.id }, data: { metadata: { version: "channex_availability_conflict_v1",
        conflict: { type, id: modification.id, proposedCheckIn: incoming.checkIn.toISOString(), proposedCheckOut: incoming.checkOut.toISOString() } } } });
      const result = await readAvailabilityConflictReview(db, actor, incoming.id);
      const cause = result.items.find(i => i.id === first.id)!.detectedCause;
      assert.equal(cause.type, type); assert.equal(cause.reservation?.id, other.id);
      assert.equal(cause.startsAt, incoming.checkIn.toISOString());
    }
  });
  await t.test("history persistence failure rolls back closure atomically", async () => {
    const issue = (await detect("rollback-review"))!;
    const broken = { $transaction: (work: (tx: any) => Promise<unknown>) => db.$transaction(tx => work(new Proxy(tx, { get(target, key) {
      if (key === "operationalIssueTransition") return new Proxy(tx.operationalIssueTransition, { get(model, method) {
        if (method === "create") return async () => { throw new Error("SYNTHETIC_HISTORY_FAILURE"); };
        return Reflect.get(model, method);
      } });
      return Reflect.get(target, key);
    } }))) } as unknown as PrismaClient;
    await assert.rejects(resolveAvailabilityConflictReview(broken, actor, issue.id, { ...command, expectedUpdatedAt: issue.updatedAt.toISOString() }), /SYNTHETIC_HISTORY_FAILURE/);
    assert.equal((await db.operationalIssue.findUniqueOrThrow({ where: { id: issue.id } })).workflowState, "ACTION_REQUIRED");
    assert.equal(await db.operationalIssueTransition.count({ where: { issueId: issue.id } }), 1);
  });
});
