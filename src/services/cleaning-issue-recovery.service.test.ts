import test from "node:test";
import assert from "node:assert/strict";
import { recoverCleaningIssue, processCleaningIssueRecoveries } from "./cleaning-issue-recovery.service.js";

function fixture(decision = "FOLLOW_ESTIMATE") {
  const work: any = { id: "work", reservationId: "reservation", propertyId: "property", staffMemberId: "cleaner", confirmationId: "offer",
    cancelledAt: null, completionConfirmedAt: null, supersededAt: null, durationCommitmentMinutes: 60 };
  const persisted: any[] = [], notices: any[] = [], actions: string[] = [];
  let extensionState = "APPLIED"; let backupRecovery = "BACKUP_OFFER_PENDING";
  const db: any = { cleaningWork: { findUnique: async () => work },
    cleaningWorkIssueReport: { findFirst: async () => ({ id: "report", reason: "Private cleaner free text" }) },
    reservation: { findFirst: async () => ({ id: "reservation", propertyId: "property", status: "ACTIVE", reservationNumber: "TEST",
      property: { name: "Synthetic", status: "ACTIVE", organizationId: "org", timezone: "America/Puerto_Rico" } }) },
    operationalIssue: { findUnique: async () => null },
    cleaningConfirmation: { findFirst: async () => ({ status: "PENDING" }) },
    $transaction: async (fn: any) => fn(db),
  };
  const deps: any = {
    allowed: async () => true,
    assess: async () => ({ decision, reason: "SYNTHETIC_REASON" }),
    extend: async (_db: any, scope: any) => { assert.deepEqual(scope, { reportId: "report", organizationId: "org" }); actions.push("extend"); return { state: extensionState }; },
    backup: async (_db: any, scope: any) => { assert.equal(scope.staffMemberId, "cleaner"); actions.push("offer-backup"); return { recovery: backupRecovery }; },
    persist: async (_db: any, input: any) => { persisted.push(input); },
    notify: async (_db: any, workId: string, reason: string) => { notices.push({ workId, reason }); },
  };
  return { db, deps, work, persisted, notices, actions, state: (state: string) => { extensionState = state; }, backup: (state: string) => { backupRecovery = state; } };
}
const daytime = new Date("2026-10-07T19:00:00Z");
test("acknowledged extension is resolved; an ambiguous response is escalated without claiming access", async () => {
  const f = fixture("ACCESS_EXTENSION_REQUIRED");
  assert.equal((await recoverCleaningIssue(f.db, "work", daytime, f.deps)).state, "ACCESS_EXTENDED");
  assert.deepEqual(f.actions, ["extend"]); assert.equal(f.persisted[0].workflowState, "RESOLVED"); assert.equal(f.notices.length, 0);
  const g = fixture("ACCESS_EXTENSION_REQUIRED"); g.state("UNCERTAIN");
  const result = await recoverCleaningIssue(g.db, "work", daytime, g.deps);
  assert.equal(result.accessChanged, false); assert.equal(g.persisted[0].actionRequired, true); assert.equal(g.notices.length, 1);
});
test("feasible estimates are monitored while host-boundary cases reuse host attention", async () => {
  const f = fixture(); const before = structuredClone(f.work);
  await recoverCleaningIssue(f.db, "work", daytime, f.deps);
  assert.deepEqual(f.actions, []); assert.equal(f.notices.length, 0); assert.equal(f.persisted[0].workflowState, "WAITING"); assert.deepEqual(f.work, before);
  const g = fixture("HOST_REVIEW_REQUIRED"); await recoverCleaningIssue(g.db, "work", daytime, g.deps);
  assert.deepEqual(g.actions, []); assert.equal(g.notices[0].workId, "work");
  assert.equal(g.persisted[0].operationalKey, "CLEANING_RECOVERY:report");
  assert.doesNotMatch(JSON.stringify(g.persisted), /Private cleaner free text/);
});
test("incomplete work creates an offer, never an automatic acceptance; exhaustion goes to host", async () => {
  const f = fixture("BACKUP_REVIEW_REQUIRED"); await recoverCleaningIssue(f.db, "work", daytime, f.deps);
  assert.deepEqual(f.actions, ["offer-backup"]); assert.equal(f.persisted[0].workflowState, "WAITING");
  const g = fixture("BACKUP_REVIEW_REQUIRED"); g.backup("NO_VIABLE_BACKUP");
  assert.equal((await recoverCleaningIssue(g.db, "work", daytime, g.deps)).state, "HOST_REVIEW_REQUIRED"); assert.equal(g.notices.length, 1);
});
test("waiting backup preserves explicit acceptance and leaves quiet-hours alerts to the dispatcher", async () => {
  const f = fixture(); f.work.supersededAt = daytime;
  const result = await recoverCleaningIssue(f.db, "work", new Date("2026-10-08T02:00:00Z"), f.deps);
  assert.equal(result.reason, "EXPLICIT_ACCEPTANCE_REQUIRED"); assert.equal(f.persisted[0].actionRequired, false);
  assert.deepEqual(f.actions, []);
});
test("completion closes the report workflow without inferring physical completion", async () => {
  const f = fixture("ACCESS_EXTENSION_REQUIRED"); f.work.completionConfirmedAt = daytime;
  await recoverCleaningIssue(f.db, "work", daytime, f.deps);
  assert.deepEqual(f.actions, []); assert.equal(f.persisted[0].metadata.cleaningCompletionInferred, false);
  assert.equal(f.persisted[0].workflowState, "RESOLVED");
});
function scanFixture(count: number) {
  const rows = Array.from({ length: count }, (_, index) => ({ id: `work-${String(index).padStart(3, "0")}` }));
  const queries: any[] = [];
  const db: any = { cleaningWork: { findMany: async (query: any) => {
    queries.push(query);
    return rows.filter(row => !query.where.id || row.id > query.where.id.gt).slice(0, query.take);
  } } };
  return { db, rows, queries };
}
test("a scan processes all pages despite failures and rediscovers failed work on the next run", async () => {
  const f = scanFixture(61); const attempted: string[] = [];
  const recover = async (_db: any, id: string) => {
    attempted.push(id);
    if (id === "work-000" || id === "work-025") throw new Error("transient database failure");
  };
  assert.deepEqual(await processCleaningIssueRecoveries(f.db, daytime, 25, recover), { processed: 61, failures: 2 });
  assert.deepEqual(attempted, f.rows.map(row => row.id));
  assert.deepEqual(f.queries.map(query => query.where.id), [undefined, { gt: "work-024" }, { gt: "work-049" }]);
  attempted.length = 0;
  assert.deepEqual(await processCleaningIssueRecoveries(f.db, daytime, 25, async (_db, id) => { attempted.push(id); }), { processed: 61, failures: 0 });
  assert.deepEqual(attempted, f.rows.map(row => row.id));
  assert.equal(f.queries[3].where.id, undefined);
});
test("an interrupted database scan starts from durable rows on the next invocation", async () => {
  const f = scanFixture(3); const read = f.db.cleaningWork.findMany;
  let reads = 0;
  f.db.cleaningWork.findMany = async (query: any) => {
    if (++reads === 2) throw new Error("connection lost");
    return read(query);
  };
  const attempted: string[] = [];
  const recover = async (_db: any, id: string) => { attempted.push(id); };
  await assert.rejects(processCleaningIssueRecoveries(f.db, daytime, 1, recover), /connection lost/);
  assert.deepEqual(attempted, ["work-000"]);
  attempted.length = 0;
  assert.deepEqual(await processCleaningIssueRecoveries(f.db, daytime, 1, recover), { processed: 3, failures: 0 });
  assert.deepEqual(attempted, f.rows.map(row => row.id));
});
test("independent worker scans never share progress and empty scans do no recovery", async () => {
  const first = scanFixture(2), restarted = scanFixture(2);
  const attempted: string[] = [];
  await processCleaningIssueRecoveries(first.db, daytime, 1, async () => { throw new Error("worker interrupted"); });
  await processCleaningIssueRecoveries(restarted.db, daytime, 1, async (_db, id) => { attempted.push(id); });
  assert.deepEqual(attempted, restarted.rows.map(row => row.id));
  assert.equal(restarted.queries[0].where.id, undefined);
  assert.deepEqual(await processCleaningIssueRecoveries(scanFixture(0).db, daytime, 25, async () => { assert.fail("no work"); }), { processed: 0, failures: 0 });
});
test("invalid page sizes fail before any database or recovery operation", async () => {
  const f = scanFixture(1);
  for (const size of [0, -1, 1.5, NaN, Infinity]) await assert.rejects(processCleaningIssueRecoveries(f.db, daytime, size), RangeError);
  assert.deepEqual(f.queries, []);
});

test("inactive or unconsented Pin AI performs no automatic recovery action", async () => {
  for (const decision of ["ACCESS_EXTENSION_REQUIRED", "BACKUP_REVIEW_REQUIRED", "FOLLOW_ESTIMATE"]) {
    const f = fixture(decision); f.deps.allowed = async () => false;
    const result = await recoverCleaningIssue(f.db, "work", daytime, f.deps);
    assert.equal(result.reason, "PIN_AI_NOT_ACTIVE_OR_CONSENTED");
    assert.deepEqual(f.actions, []); assert.equal(f.notices.length, 1);
    assert.equal(f.persisted[0].actionRequired, true);
  }
});
