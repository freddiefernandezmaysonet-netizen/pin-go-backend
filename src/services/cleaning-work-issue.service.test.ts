import test from "node:test";
import assert from "node:assert/strict";
import { parseCleaningIssue, reportCleaningIssue, readCleaningIssues } from "./cleaning-work-issue.service.js";
const now = new Date("2026-10-07T18:00:00Z");
const identity = { confirmationId: "offer", staffMemberId: "staff", organizationId: "org" };
const input = { kind: "DELAY", requestId: "request-1234567890", reason: "Traffic", estimatedAt: "2026-10-07T19:00:00Z" };
function fixture() {
  const work: any = { id: "work", startConfirmedAt: null, completionConfirmedAt: null, cancelledAt: null, supersededAt: null };
  let offers: any[] = [{ id: "offer" }];
  let active = true;
  let locked = false;
  const reports: any[] = [];
  let outcome: any = null;
  let hasWork = true;
  const tx: any = {
    $queryRaw: async () => { locked = true; },
    cleaningConfirmation: { findFirst: async ({ where }: any) => where.staffMemberId === "staff" ? { id: "offer", reservationId: "res", propertyId: "property" } : null,
      findMany: async () => offers },
    reservation: { findFirst: async ({ where }: any) => {
      if (where.property.organizationId !== "org" || (!active && where.status === "ACTIVE")) return null;
      return { id: "res", status: active ? "ACTIVE" : "CANCELLED", property: { status: "ACTIVE" } };
    } },
    staffMember: { findFirst: async ({ where }: any) => where.organizationId === "org" ? { id: "staff" } : null },
    cleaningWork: { findMany: async ({ where }: any) => { assert.equal(where.confirmationId, "offer"); assert.equal(where.staffMemberId, "staff"); assert.equal(where.reservationId, "res"); assert.equal(where.propertyId, "property"); return hasWork ? [work] : []; } },
    operationalIssue: { findFirst: async ({ where }: any) => {
      assert.equal(where.operationalKey, "CLEANING_RECOVERY:report-0");
      assert.equal(where.organizationId, "org"); assert.equal(where.propertyId, "property"); assert.equal(where.reservationId, "res");
      return outcome;
    } },
    cleaningWorkIssueReport: {
      findFirst: async () => reports.at(-1) ?? null,
      findUnique: async ({ where }: any) => reports.find(r => r.requestId === where.cleaningWorkId_requestId.requestId) ?? null,
      create: async ({ data }: any) => { assert.equal(locked, true); const row = { id: `report-${reports.length}`, ...data }; reports.push(row); return row; },
      findMany: async () => reports,
    },
  };
  return { db: { $transaction: async (fn: any) => fn(tx) } as any, work, reports,
    replace: () => { offers = [{ id: "backup" }]; }, ambiguous: () => { offers.push({ id: "other" }); }, deactivate: () => { active = false; },
    outcome: (state: unknown) => { outcome = { metadata: { recoveryState: state, nfcCardId: "private-card", token: "private-token" } }; },
    noWork: () => { hasWork = false; } };
}
test("declaration preserves work and does not need access, completion, messaging or reassignment writers", async () => {
  const f = fixture(); const before = structuredClone(f.work);
  const result = await reportCleaningIssue(f.db, identity, input, now);
  assert.equal(result.recoveryStatus, "RECORDED"); assert.equal(f.reports.length, 1);
  assert.deepEqual(f.work, before);
  assert.equal((await readCleaningIssues(f.db, identity)).reports.length, 1);
});
test("retry with identical request records once; changed payload conflicts", async () => {
  const f = fixture();
  await reportCleaningIssue(f.db, identity, input, now);
  await reportCleaningIssue(f.db, identity, input, new Date("2026-10-07T20:00:00Z"));
  assert.equal(f.reports.length, 1);
  await assert.rejects(reportCleaningIssue(f.db, identity, { ...input, reason: "Changed" }, now), /CLEANING_REPORT_CONFLICT/);
});
test("foreign cleaner, inactive reservation, replacement and ambiguous offer cannot report", async () => {
  const f = fixture();
  await assert.rejects(reportCleaningIssue(f.db, { ...identity, staffMemberId: "foreign" }, input, now), /CLEANING_NOT_AVAILABLE/);
  for (const change of ["replace", "ambiguous", "deactivate"] as const) {
    const g = fixture(); g[change]();
    await assert.rejects(reportCleaningIssue(g.db, identity, input, now), /CLEANING_NOT_AVAILABLE/);
    assert.equal(g.reports.length, 0);
  }
});
test("closed work cannot accept a report", async () => {
  for (const key of ["cancelledAt", "supersededAt", "completionConfirmedAt"]) {
    const f = fixture(); f.work[key] = now;
    await assert.rejects(reportCleaningIssue(f.db, identity, input, now), /CLEANING_WORK_CLOSED/);
  }
});
test("delay is pre-start; more-time/incomplete require explicit start", async () => {
  const f = fixture();
  await assert.rejects(reportCleaningIssue(f.db, identity, { ...input, kind: "MORE_TIME" }, now), /PHASE_INVALID/);
  f.work.startConfirmedAt = now;
  await assert.rejects(reportCleaningIssue(f.db, identity, input, now), /PHASE_INVALID/);
  await reportCleaningIssue(f.db, identity, { ...input, kind: "MORE_TIME" }, now);
  await reportCleaningIssue(f.db, identity, { ...input, requestId: "request-incomplete1", kind: "INCOMPLETE", estimatedAt: null }, now);
  assert.equal(f.reports.length, 2); assert.equal(f.work.completionConfirmedAt, null);
});
test("estimates must be future instants with timezone and bounded input", async () => {
  for (const estimatedAt of ["2026-10-07T17:00:00Z", "2026-10-09T18:00:00Z", "2026-10-07T19:00:00", "invalid"]) {
    await assert.rejects(reportCleaningIssue(fixture().db, identity, { ...input, estimatedAt }, now), /ESTIMATE_INVALID/);
  }
  assert.throws(() => parseCleaningIssue({ ...input, reason: " " }), /ISSUE_INVALID/);
  assert.throws(() => parseCleaningIssue({ ...input, reason: "x".repeat(1001) }), /ISSUE_INVALID/);
  assert.throws(() => parseCleaningIssue({ ...input, kind: "COMPLETE" }), /ISSUE_INVALID/);
});

test("own reports remain readable after completion, cancellation or reassignment, but writes remain closed", async () => {
  for (const key of ["cancelledAt", "supersededAt", "completionConfirmedAt"]) {
    const f = fixture();
    await reportCleaningIssue(f.db, identity, input, now);
    f.work[key] = now; f.replace(); f.outcome("BACKUP_ACCEPTED");
    const before = structuredClone(f.work);
    const result = await readCleaningIssues(f.db, identity, now);
    assert.equal(result.reports.length, 1); assert.equal(result.canReport, false);
    assert.equal(result.assessment?.decision, "REPORT_SUPERSEDED");
    assert.deepEqual(result.recoveryOutcome, { state: "BACKUP_ACCEPTED" });
    assert.deepEqual(f.work, before);
    await assert.rejects(reportCleaningIssue(f.db, identity, input, now), /CLEANING_NOT_AVAILABLE/);
  }
});

test("historical reads preserve cleaner and organization scope and do not expose worker metadata", async () => {
  const f = fixture(); await reportCleaningIssue(f.db, identity, input, now);
  f.deactivate(); f.outcome("BACKUP_OFFER_PENDING");
  const result = await readCleaningIssues(f.db, identity, now);
  assert.equal(result.canReport, false); assert.equal(result.reports.length, 1);
  assert.deepEqual(result.recoveryOutcome, { state: "BACKUP_OFFER_PENDING" });
  assert.doesNotMatch(JSON.stringify(result), /private-card|private-token/);
  await assert.rejects(readCleaningIssues(f.db, { ...identity, staffMemberId: "foreign" }, now), /CLEANING_NOT_AVAILABLE/);
  await assert.rejects(readCleaningIssues(f.db, { ...identity, organizationId: "foreign" }, now), /CLEANING_NOT_AVAILABLE/);
  f.outcome("UNKNOWN_INTERNAL_STATE");
  assert.equal((await readCleaningIssues(f.db, identity, now)).recoveryOutcome, null);
});

test("offers without a work snapshot have an empty read-only report history", async () => {
  const f = fixture(); f.noWork();
  assert.deepEqual(await readCleaningIssues(f.db, identity, now), {
    reports: [], assessment: null, recoveryOutcome: null, canReport: false, recoveryStatus: "RECORDED",
  });
});
