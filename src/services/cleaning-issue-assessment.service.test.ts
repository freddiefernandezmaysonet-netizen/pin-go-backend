import test from "node:test";
import assert from "node:assert/strict";
import { assessCleaningIssue, assessLatestCleaningIssue, type CleaningIssueAssessmentInput } from "./cleaning-issue-assessment.service.js";
const d = (hour: number, minute = 0) => new Date(Date.UTC(2026, 9, 7, hour, minute));
function fixture(): CleaningIssueAssessmentInput {
  return { work: { id: "work", reservationId: "res", propertyId: "property", staffMemberId: "staff", confirmationId: "offer", scheduledStartAt: d(16), durationCommitmentMinutes: 60, startConfirmedAt: null, completionConfirmedAt: null, cancelledAt: null, supersededAt: null, timingConsentAcceptedAt: d(15) },
    report: { kind: "DELAY", estimatedAt: d(16, 15), reportedAt: d(16) },
    policy: { revision: 1, maxDelayMinutes: 30, maxAccessExtensionMinutes: 60, arrivalSafetyMarginMinutes: 15 },
    accessEnd: d(19), latestStartAt: d(19), nextCheckIn: d(20), now: d(16) };
}
test("routine delay within limits follows estimate without changing committed duration or access", () => {
  const f = fixture(); const before = structuredClone(f);
  const result = assessCleaningIssue(f);
  assert.equal(result.decision, "FOLLOW_ESTIMATE"); assert.deepEqual(result.estimatedFinishAt, d(17, 15));
  assert.equal(result.authorizationGranted, false); assert.equal(result.accessChanged, false); assert.equal(result.actionsExecuted, false);
  assert.deepEqual(f, before);
});
test("host delay limit and next-arrival safety boundary are enforced", () => {
  const f = fixture(); f.report!.estimatedAt = d(16, 31);
  assert.equal(assessCleaningIssue(f).reason, "HOST_DELAY_LIMIT_EXCEEDED");
  f.report!.estimatedAt = d(16, 15); f.nextCheckIn = d(17, 30);
  assert.equal(assessCleaningIssue(f).reason, "NEXT_ARRIVAL_AT_RISK");
});
test("extension requires started work, no next check-in and host limit including exclusive completion buffer", () => {
  const f = fixture(); f.work.startConfirmedAt = d(16); f.report!.kind = "MORE_TIME"; f.report!.estimatedAt = d(19, 30); f.nextCheckIn = null;
  const result = assessCleaningIssue(f);
  assert.equal(result.decision, "ACCESS_EXTENSION_REQUIRED"); assert.deepEqual(result.proposedAccessEnd, d(19, 31));
  assert.equal(result.actionsExecuted, false);
  f.nextCheckIn = d(21);
  assert.equal(assessCleaningIssue(f).reason, "ACCESS_EXTENSION_BLOCKED_BY_NEXT_CHECKIN");
  f.nextCheckIn = null; f.policy.maxAccessExtensionMinutes = 0;
  assert.equal(assessCleaningIssue(f).reason, "HOST_EXTENSION_LIMIT_EXCEEDED");
  f.policy.maxAccessExtensionMinutes = 30;
  assert.equal(assessCleaningIssue(f).reason, "HOST_EXTENSION_LIMIT_EXCEEDED");
});
test("start window cannot be reopened by a delay report or extension proposal", () => {
  const f = fixture(); f.nextCheckIn = null; f.report!.estimatedAt = d(19);
  assert.equal(assessCleaningIssue(f).reason, "START_WINDOW_CLOSED");
  f.report!.estimatedAt = d(18, 30); f.policy.maxDelayMinutes = 240;
  assert.equal(assessCleaningIssue(f).reason, "EXTENSION_REQUIRES_STARTED_WORK");
});
test("incomplete work requests backup review, not cancellation/completion or automatic acceptance", () => {
  const f = fixture(); f.work.startConfirmedAt = d(16); f.report = { kind: "INCOMPLETE", estimatedAt: null, reportedAt: d(16) };
  assert.equal(assessCleaningIssue(f).decision, "BACKUP_REVIEW_REQUIRED"); assert.equal(f.work.completionConfirmedAt, null);
});
test("started/completed/superseded work and elapsed or invalid estimates do not produce stale actions", () => {
  const f = fixture(); f.work.startConfirmedAt = d(16);
  assert.equal(assessCleaningIssue(f).reason, "START_RECORDED");
  f.report!.kind = "MORE_TIME"; f.report!.estimatedAt = d(16);
  assert.equal(assessCleaningIssue(f).reason, "REPORTED_ESTIMATE_ELAPSED");
  f.work.completionConfirmedAt = d(16);
  assert.equal(assessCleaningIssue(f).decision, "REPORT_SUPERSEDED");
  const invalid = fixture(); invalid.nextCheckIn = new Date("invalid");
  assert.equal(assessCleaningIssue(invalid).decision, "CONTEXT_UNAVAILABLE");
});
test("read adapter uses latest report and refuses unverified current access/window", async () => {
  const f = fixture(); const queries: any[] = [];
  const tx: any = { cleaningWorkIssueReport: { findFirst: async (query: any) => { queries.push(query); return f.report; } },
    cleaningRecoveryPolicy: { findUnique: async () => f.policy }, reservation: { findFirst: async () => null }, staffAssignment: { findUnique: async () => null } };
  const result = await assessLatestCleaningIssue(tx, f.work, f.now);
  assert.equal(result?.decision, "CONTEXT_UNAVAILABLE"); assert.equal(result?.actionsExecuted, false);
  assert.deepEqual(queries[0].where, { cleaningWorkId: "work" });
  assert.deepEqual(queries[0].orderBy, [{ reportedAt: "desc" }, { id: "desc" }]);
});
