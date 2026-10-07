import test from "node:test";
import assert from "node:assert/strict";
import { prepareCleanerAccessExtension } from "./cleaner-access-extension-plan.service.js";
const now = new Date("2026-10-07T19:00:00Z");
const start = new Date(now.getTime() - 10 * 60000);
const end = new Date(now.getTime() + 20 * 60000);
function fixture() {
  const work: any = { id: "work", reservationId: "res", propertyId: "property", staffMemberId: "staff", confirmationId: "offer", scheduledStartAt: start, durationCommitmentMinutes: 30, startConfirmedAt: start, timingConsentAcceptedAt: start, completionConfirmedAt: null, cancelledAt: null, supersededAt: null };
  const report: any = { id: "report", cleaningWorkId: "work", work, kind: "MORE_TIME", reportedAt: start, estimatedAt: new Date(now.getTime() + 30 * 60000) };
  const grant: any = { id: "grant", status: "ACTIVE", startsAt: start, endsAt: end };
  const receipt: any = { state: "ACKNOWLEDGED", acknowledgedAt: start, confirmationId: "offer", organizationId: "org", ttlockLockId: 42, ttlockCardId: 123, startsAt: start, endsAt: end };
  let latest: any = report; let next: any = null; let conflict: any = null; let offers: any[] = [{ id: "offer", staffMemberId: "staff", status: "CONFIRMED" }]; let locked = false;
  const tx: any = {
    $queryRaw: async () => { locked = true; },
    cleaningWorkIssueReport: { findUnique: async () => report, findFirst: async () => latest },
    reservation: { findFirst: async (args: any) => args.where.id?.not ? next : args.where.property?.organizationId && args.where.property.organizationId !== "org" ? null : args.include?.property ? { id: "res", propertyId: "property", checkOut: start, source: "INTERNAL_DEMO_DIRECT_BOOKING", property: { status: "ACTIVE", organizationId: "org", cleaningStartOffsetMinutes: 0 } } : { checkOut: start } },
    cleaningConfirmation: { findMany: async () => { assert.equal(locked, true); return offers; }, findFirst: async () => ({ id: "offer" }) },
    cleaningRecoveryPolicy: { findUnique: async () => ({ revision: 2, maxDelayMinutes: 30, maxAccessExtensionMinutes: 60, arrivalSafetyMarginMinutes: 0 }) },
    propertyStaff: { findFirst: async () => ({ id: "mapping" }) },
    staffAssignment: { findUnique: async () => ({ endsAt: end }) },
    staffMember: { findFirst: async () => ({ ttlockCardRef: "own-ref" }) },
    nfcCard: { findMany: async ({ where }: any) => { assert.equal(where.label, "own-ref"); return [{ id: "card", ttlockCardId: 123 }]; } },
    nfcAssignment: { findMany: async ({ where }: any) => { assert.equal(where.nfcCardId, "card"); return [grant]; }, findFirst: async () => conflict },
    cleanerNfcProgrammingAttempt: { findFirst: async () => receipt },
    lock: { findFirst: async ({ where }: any) => where.ttlockLockId === 42 && where.propertyId === "property" ? { id: "lock" } : null },
  };
  return { db: { $transaction: async (fn: any) => fn(tx) } as any, work, report, grant, receipt,
    supersede: () => { latest = { ...report, id: "new-report" }; }, arrive: () => { next = { checkIn: new Date(now.getTime() + 120 * 60000) }; }, replace: () => { offers = [{ id: "backup", staffMemberId: "other", status: "CONFIRMED" }]; }, conflict: () => { conflict = { id: "other-grant" }; } };
}
test("extension preparation uses exact acknowledged target and leaves all state untouched", async () => {
  const f = fixture(); const before = structuredClone([f.work, f.grant, f.receipt]);
  const plan = await prepareCleanerAccessExtension(f.db, { reportId: "report", organizationId: "org" }, now);
  assert.equal(plan.lockId, 42); assert.equal(plan.cardId, 123); assert.equal(plan.nfcAssignmentId, "grant");
  assert.equal(plan.policyRevision, 2); assert.equal(plan.idempotencyKey, "CLEANER_ACCESS_EXTENSION:report");
  assert.equal(plan.actionsExecuted, false); assert.equal(plan.authorizationGranted, false); assert.equal(plan.physicalAccessVerified, false);
  assert.deepEqual(plan.previousEndsAt, end); assert.deepEqual(plan.proposedEndsAt, new Date(now.getTime() + 31 * 60000));
  assert.deepEqual([f.work, f.grant, f.receipt], before);
});
test("foreign scope, new arrival, replacement, newer report and card overlap reject preparation", async () => {
  await assert.rejects(prepareCleanerAccessExtension(fixture().db, { reportId: "report", organizationId: "foreign" }, now), /SCOPE_INVALID/);
  for (const change of ["supersede", "arrive", "replace", "conflict"] as const) {
    const f = fixture(); f[change]();
    await assert.rejects(prepareCleanerAccessExtension(f.db, { reportId: "report", organizationId: "org" }, now), /CLEANER_EXTENSION_/);
  }
});
test("missing/uncertain/historical target evidence is not replaced by a guessed property lock", async () => {
  for (const mutate of [(r: any) => { r.state = "UNCERTAIN"; }, (r: any) => { r.ttlockCardId = 999; }, (r: any) => { r.confirmationId = "old-offer"; }, (r: any) => { r.endsAt = start; }, (r: any) => { r.ttlockLockId = 999; }]) {
    const f = fixture(); mutate(f.receipt);
    await assert.rejects(prepareCleanerAccessExtension(f.db, { reportId: "report", organizationId: "org" }, now), /UNVERIFIED/);
  }
});
test("closed work or a programming transition cannot produce an extension command", async () => {
  const f = fixture(); f.work.completionConfirmedAt = now;
  await assert.rejects(prepareCleanerAccessExtension(f.db, { reportId: "report", organizationId: "org" }, now), /WORK_NOT_ELIGIBLE/);
  const g = fixture(); g.grant.status = "PROVISIONING";
  await assert.rejects(prepareCleanerAccessExtension(g.db, { reportId: "report", organizationId: "org" }, now), /ACCESS_NOT_STABLE/);
});
