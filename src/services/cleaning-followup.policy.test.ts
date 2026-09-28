import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCleaningFollowup } from "./cleaning-followup.policy.js";

const at = (iso: string) => new Date(iso);
const base = {
  scheduledStartAt: at("2026-09-28T15:30:00.000Z"), // 11:30 Puerto Rico
  durationMinutes: 120,
  startConfirmationGraceMinutes: 30,
  followupGraceMinutes: 15,
  startConfirmedAt: null,
  completionConfirmedAt: null,
  cancelled: false,
};

test("start reminder is due at the configured 30 minute boundary", () => {
  assert.equal(
    evaluateCleaningFollowup(base, at("2026-09-28T16:00:00.000Z")).decision,
    "START_REMINDER_DUE",
  );
});

test("late start confirmation never moves the committed completion time", () => {
  const result = evaluateCleaningFollowup(
    { ...base, startConfirmedAt: at("2026-09-28T16:10:00.000Z") },
    at("2026-09-28T16:10:00.000Z"),
  );
  assert.equal(result.decision, "CLEANING_IN_PROGRESS");
  assert.equal(result.scheduledCompletionAt.toISOString(), "2026-09-28T17:30:00.000Z");
});

test("completion reminder is due at the committed completion boundary", () => {
  const result = evaluateCleaningFollowup(
    { ...base, startConfirmedAt: at("2026-09-28T15:35:00.000Z") },
    at("2026-09-28T17:30:00.000Z"),
  );
  assert.equal(result.decision, "COMPLETION_REMINDER_DUE");
});

test("host attention is due only after the follow-up grace period", () => {
  const result = evaluateCleaningFollowup(base, at("2026-09-28T17:45:00.000Z"));
  assert.equal(result.decision, "HOST_ATTENTION_DUE");
});

test("completion suppresses later reminder decisions", () => {
  const result = evaluateCleaningFollowup(
    { ...base, completionConfirmedAt: at("2026-09-28T17:20:00.000Z") },
    at("2026-09-28T18:00:00.000Z"),
  );
  assert.equal(result.decision, "COMPLETED");
});
