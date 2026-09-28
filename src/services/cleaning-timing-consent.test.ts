import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCleaningTimingConsentSnapshot,
  CLEANING_TIMING_CONSENT_VERSION,
  timingConsentMatches,
} from "./cleaning-timing-consent.js";

test("builds exact per-work consent deadlines without moving committed completion", () => {
  const snapshot = buildCleaningTimingConsentSnapshot({
    scheduledStartAt: new Date("2026-09-28T15:30:00.000Z"),
    durationCommitmentMinutes: 120,
    startConfirmationGraceMinutes: 30,
    followupGraceMinutes: 15,
  });
  assert.equal(snapshot.version, CLEANING_TIMING_CONSENT_VERSION);
  assert.equal(snapshot.startConfirmationDueAt.toISOString(), "2026-09-28T16:00:00.000Z");
  assert.equal(snapshot.scheduledCompletionAt.toISOString(), "2026-09-28T17:30:00.000Z");
  assert.equal(snapshot.followupAttentionAt.toISOString(), "2026-09-28T17:45:00.000Z");
});

test("consent is invalid when any accepted timing later changes", () => {
  const accepted = buildCleaningTimingConsentSnapshot({
    scheduledStartAt: new Date("2026-09-28T15:30:00.000Z"),
    durationCommitmentMinutes: 120,
    startConfirmationGraceMinutes: 30,
    followupGraceMinutes: 15,
  });
  assert.equal(timingConsentMatches(accepted, accepted), true);
  const changed = buildCleaningTimingConsentSnapshot({
    scheduledStartAt: new Date("2026-09-28T15:30:00.000Z"),
    durationCommitmentMinutes: 180,
    startConfirmationGraceMinutes: 30,
    followupGraceMinutes: 15,
  });
  assert.equal(timingConsentMatches(accepted, changed), false);
});
