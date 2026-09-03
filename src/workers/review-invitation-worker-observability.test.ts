import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewInvitationDispatchSummary,
  emitReviewInvitationDispatchSummary,
} from "./review-invitation-worker-observability.js";

test("an idle cycle emits a zero-count heartbeat", () => {
  assert.deepEqual(buildReviewInvitationDispatchSummary([], 12.8), {
    outcome: "IDLE",
    candidateCount: 0,
    sentCount: 0,
    failedCount: 0,
    skippedCount: 0,
    durationMs: 12,
  });
});

test("a cycle summary counts every dispatch result", () => {
  assert.deepEqual(
    buildReviewInvitationDispatchSummary(
      [
        { status: "SENT" },
        { status: "SENT" },
        { status: "FAILED" },
        { status: "SKIPPED" },
      ],
      45
    ),
    {
      outcome: "COMPLETED_WITH_FAILURES",
      candidateCount: 4,
      sentCount: 2,
      failedCount: 1,
      skippedCount: 1,
      durationMs: 45,
    }
  );
});

test("successful and idle cycles use the informational channel", () => {
  const records: Array<{ level: string; event: string; metadata: unknown }> = [];
  const logger = {
    log: (event: string, metadata: unknown) =>
      records.push({ level: "info", event, metadata }),
    error: (event: string, metadata: unknown) =>
      records.push({ level: "error", event, metadata }),
  };

  emitReviewInvitationDispatchSummary(logger, [{ status: "SENT" }], 7);
  emitReviewInvitationDispatchSummary(logger, [], 3);

  assert.deepEqual(records.map(({ level, event }) => ({ level, event })), [
    { level: "info", event: "[REVIEW_INVITATION_DISPATCH_SUMMARY]" },
    { level: "info", event: "[REVIEW_INVITATION_DISPATCH_SUMMARY]" },
  ]);
});

test("a failed result produces a detectable error without sensitive fields", () => {
  const records: Array<{ level: string; event: string; metadata: unknown }> = [];
  const logger = {
    log: (event: string, metadata: unknown) =>
      records.push({ level: "info", event, metadata }),
    error: (event: string, metadata: unknown) =>
      records.push({ level: "error", event, metadata }),
  };
  const sensitiveResult = {
    status: "FAILED",
    reservationId: "reservation-secret",
    guestEmail: "guest@example.com",
    token: "review-token-secret",
    url: "https://example.com/review/review-token-secret",
  };

  emitReviewInvitationDispatchSummary(logger, [sensitiveResult], Number.NaN);

  assert.equal(records.length, 1);
  assert.equal(records[0]?.level, "error");
  assert.deepEqual(records[0]?.metadata, {
    outcome: "COMPLETED_WITH_FAILURES",
    candidateCount: 1,
    sentCount: 0,
    failedCount: 1,
    skippedCount: 0,
    durationMs: 0,
  });

  const serialized = JSON.stringify(records);
  for (const forbidden of [
    "reservation-secret",
    "guest@example.com",
    "review-token-secret",
    "reservationId",
    "guestEmail",
    "token",
    "url",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
