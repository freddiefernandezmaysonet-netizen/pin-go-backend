import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { listStayTimeOperatorReviews as list, readStayTimeOperatorReview as read,
  recordStayTimeOperatorReview as record, parseStayTimeOperatorReview as parse } from "./stay-time-operator-review.service.js";

const url = process.env.STAY_TIME_TEST_DATABASE_URL;
const command = { requestId: "synthetic-request", expectedUpdatedAt: "2026-10-03T12:00:00.000Z", note: "Reviewed; payment evidence remains pending." };
test("operator review rejects malformed and overprivileged input", () => {
  for (const value of [null, [], {}, { ...command, resolve: true }, { ...command, note: " " },
    { ...command, note: "x".repeat(2001) }, { ...command, expectedUpdatedAt: "yesterday" },
    { ...command, requestId: "../bad" }]) assert.throws(() => parse(value), /INVALID_REVIEW_REQUEST/);
});
test("operator inbox authorization, safe projection, concurrency and financial immutability", { skip: !url }, async t => {
  const parsed = new URL(url!); assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname));
  assert.equal(parsed.pathname, "/pingo_stay_time_test");
  const db = new PrismaClient({ datasources: { db: { url } } });
  const adminOrg = await db.organization.create({ data: { name: "Synthetic platform" } });
  const org = await db.organization.create({ data: { name: "Synthetic operator target" } });
  const user = await db.dashboardUser.create({ data: { organizationId: adminOrg.id, email: `${adminOrg.id}@synthetic.invalid`,
    passwordHash: "synthetic-not-a-password", role: "PLATFORM_ADMIN", isActive: true } });
  const actor = { id: user.id, orgId: adminOrg.id, role: "PLATFORM_ADMIN" };
  const property = await db.property.create({ data: { organizationId: org.id, name: "Synthetic house", timezone: "America/Puerto_Rico" } });
  const r = await db.reservation.create({ data: { propertyId: property.id, guestName: "PRIVATE_GUEST", reservationNumber: `PG-${org.id}`,
    checkIn: new Date("2026-10-01T19:00Z"), checkOut: new Date("2026-10-03T16:00Z") } });
  t.after(async () => {
    await db.operationalIssue.deleteMany({ where: { organizationId: org.id } });
    await db.reservationModification.deleteMany({ where: { reservationId: r.id } });
    await db.reservation.delete({ where: { id: r.id } }); await db.property.delete({ where: { id: property.id } });
    await db.dashboardUser.delete({ where: { id: user.id } });
    await db.organization.deleteMany({ where: { id: { in: [org.id, adminOrg.id] } } }); await db.$disconnect();
  });
  const m = await db.reservationModification.create({ data: { reservationId: r.id, clientRequestId: "synthetic", requestFingerprint: "synthetic",
    status: "AWAITING_PAYMENT", financialAction: "ADDITIONAL_PAYMENT_REQUIRED", requestSource: "PIN_AI_GUEST_SERVICES", baseReservationUpdatedAt: r.updatedAt,
    currentCheckIn: r.checkIn, currentCheckOut: r.checkOut, proposedCheckIn: r.checkIn, proposedCheckOut: r.checkOut,
    currentAdults: 1, currentChildren: 0, proposedAdults: 1, proposedChildren: 0, currentPricing: { secret: "PRIVATE_PRICE" }, proposedPricing: {},
    currentTotalAmount: 100, proposedTotalAmount: 120, amountDifference: 20, additionalChargeAmount: 20,
    guestConfirmation: { operation: "LATE_CHECKOUT", secret: "PRIVATE_TOKEN" }, stripeCheckoutSessionId: "PRIVATE_CHECKOUT",
    failureMessage: "PRIVATE_PROVIDER_ERROR", stayTimeRecoveryAttempts: 6 } });
  const issue = await db.operationalIssue.create({ data: { operationalKey: `STAY_TIME_RECOVERY_REVIEW:${m.id}`,
    issueCode: "STAY_TIME_RECOVERY_REVIEW", title: "Synthetic", issue: "PRIVATE_ISSUE", engine: "PIN_AI", severity: "CRITICAL",
    workflowState: "ACTION_REQUIRED", visibility: "DEVELOPER", responsibleActor: "PIN_GO", actionRequired: true, canAutoResolve: true,
    sourceType: "ENGINE_EVENT", actionTarget: "PAYMENT", organizationId: org.id, propertyId: property.id, reservationId: r.id,
    metadata: { version: "stay_time_recovery_review_v1", private: "PRIVATE_METADATA" } } });
  await t.test("active platform admin can read across organizations; stale role and account claims cannot", async () => {
    assert.equal((await list(db, actor, {})).items.some(i => i.id === issue.id), true);
    for (const override of [{ role: "ORG_ADMIN" }, { orgId: org.id }, { id: "unknown-admin" }])
      await assert.rejects(read(db, { ...actor, ...override }, issue.id), /PLATFORM_ADMIN_REQUIRED/);
    await db.dashboardUser.update({ where: { id: user.id }, data: { isActive: false } });
    await assert.rejects(record(db, actor, issue.id, command), /PLATFORM_ADMIN_REQUIRED/);
    await db.dashboardUser.update({ where: { id: user.id }, data: { isActive: true, role: "ORG_ADMIN" } });
    await assert.rejects(read(db, actor, issue.id), /PLATFORM_ADMIN_REQUIRED/);
    await db.dashboardUser.update({ where: { id: user.id }, data: { role: "PLATFORM_ADMIN" } });
  });
  await t.test("projection excludes secrets and does not equate missing evidence with unpaid", async () => {
    const result = await read(db, actor, issue.id); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
    assert.equal(result.item.paymentEvidence, "UNVERIFIED"); assert.equal(result.item.physicalAccessCertified, false);
    assert.equal(result.item.additionalChargeAmount, "20");
    await db.operationalIssue.update({ where: { id: issue.id }, data: { propertyId: "wrong-property" } });
    await assert.rejects(read(db, actor, issue.id), /RECOVERY_REVIEW_NOT_FOUND/);
    assert.equal((await list(db, actor, {})).items.some(i => i.id === issue.id), false);
    await db.operationalIssue.update({ where: { id: issue.id }, data: { propertyId: property.id, issueCode: "OTHER" } });
    await assert.rejects(read(db, actor, issue.id), /RECOVERY_REVIEW_NOT_FOUND/);
    await db.operationalIssue.update({ where: { id: issue.id }, data: { issueCode: "STAY_TIME_RECOVERY_REVIEW" } });
  });
  await t.test("concurrent duplicate is recorded once, retries replay and changed payload conflicts", async () => {
    const { item } = await read(db, actor, issue.id); const input = { ...command, expectedUpdatedAt: item.updatedAt };
    const results = await Promise.all([record(db, actor, issue.id, input), record(db, actor, issue.id, input)]);
    assert.equal(results.filter(v => v.replayed).length, 1);
    assert.equal(await db.operationalIssueTransition.count({ where: { issueId: issue.id } }), 1);
    assert.equal((await record(db, actor, issue.id, input)).replayed, true);
    await assert.rejects(record(db, actor, issue.id, { ...input, note: "Changed note" }), /REVIEW_REQUEST_CONFLICT/);
    await assert.rejects(record(db, actor, issue.id, { ...input, requestId: "second-request" }), /RECOVERY_REVIEW_STALE/);
    const saved = await read(db, actor, issue.id); assert.equal(saved.item.state, "ACTION_REQUIRED");
    assert.equal(saved.history[0].note, command.note); assert.notEqual(saved.item.updatedAt, item.updatedAt);
    assert.deepEqual(await db.reservationModification.findUniqueOrThrow({ where: { id: m.id } }), m);
    assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: r.id } }), r);
    const original = await db.operationalIssue.findUniqueOrThrow({ where: { id: issue.id } });
    assert.equal(original.actionRequired, true); assert.equal(original.resolvedAt, null);
  });
  await t.test("terminal no-payment receipt is projected without exposing its private journal", async () => {
    await db.reservationModification.update({ where: { id: m.id }, data: { status: "EXPIRED", failureCode: "STAY_TIME_EXPIRED_UNPAID",
      failureDetails: { version: "stay_time_unpaid_expiry_v1", checkoutSessionId: "PRIVATE_CHECKOUT" } } });
    const detail = await read(db, actor, issue.id);
    assert.equal(detail.item.paymentEvidence, "UNPAID"); assert.doesNotMatch(JSON.stringify(detail), /PRIVATE_/);
    await db.reservationModification.update({ where: { id: m.id }, data: { status: m.status, failureCode: null } });
  });
  await t.test("different commands racing on one version cannot both record", async () => {
    const { item } = await read(db, actor, issue.id);
    const results = await Promise.allSettled(["review-race-a", "review-race-b"].map(requestId =>
      record(db, actor, issue.id, { ...command, requestId, expectedUpdatedAt: item.updatedAt })));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
    assert.match(rejected.reason.message, /RECOVERY_REVIEW_STALE/);
    assert.equal(await db.operationalIssueTransition.count({ where: { issueId: issue.id } }), 2);
  });
  await t.test("resolved incidents remain readable but refuse new review; history is bounded", async () => {
    await db.operationalIssue.update({ where: { id: issue.id }, data: { workflowState: "RESOLVED" } });
    const { item } = await read(db, actor, issue.id);
    await assert.rejects(record(db, actor, issue.id, { ...command, requestId: "resolved-request", expectedUpdatedAt: item.updatedAt }), /RECOVERY_REVIEW_STALE/);
    assert.equal((await list(db, actor, { state: "RESOLVED" })).items.some(i => i.id === issue.id), true);
    assert.equal((await list(db, actor, {})).items.some(i => i.id === issue.id), false);
    await db.operationalIssueTransition.createMany({ data: Array.from({ length: 51 }, (_, n) => ({ issueId: issue.id,
      operationalKey: issue.operationalKey, issueCode: issue.issueCode, toWorkflowState: "RESOLVED" as const,
      transitionCode: "RECOVERY", transitionSummary: "PRIVATE_EVENT", transitionedBy: "PIN_GO" as const, sourceType: "ENGINE_EVENT" as const,
      occurredAt: new Date(Date.now() + n + 100) })) });
    const detail = await read(db, actor, issue.id); assert.equal(detail.history.length, 50); assert.equal(detail.historyHasMore, true);
    assert.doesNotMatch(JSON.stringify(detail), /PRIVATE_EVENT/);
  });
});
