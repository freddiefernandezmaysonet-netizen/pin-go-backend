import assert from "node:assert/strict";
import test from "node:test";
import { CleaningTimingValidationError, parseCleaningTimingUpdate } from "./cleaning-timing-config.js";

test("legacy Staff submission leaves every saved timing unchanged", () => {
  assert.deepEqual(parseCleaningTimingUpdate({ propertyId: "p", role: "PRIMARY", isActive: true }), {});
});
test("partial timing update leaves other settings unchanged", () => {
  assert.deepEqual(parseCleaningTimingUpdate({ cleaningFollowupGraceMinutes: 25 }), { cleaningFollowupGraceMinutes: 25 });
});
test("explicit clearing affects nullable duration only", () => {
  for (const value of [null, ""]) {
    assert.deepEqual(parseCleaningTimingUpdate({ cleaningDurationCommitmentMinutes: value }),
      { cleaningDurationCommitmentMinutes: null });
  }
});
test("whole numeric form strings are supported without truncation", () => {
  assert.deepEqual(parseCleaningTimingUpdate({ cleaningDurationCommitmentMinutes: " 120 ",
    cleaningStartConfirmationGraceMinutes: "30", cleaningFollowupGraceMinutes: 15 }), {
    cleaningDurationCommitmentMinutes: 120, cleaningStartConfirmationGraceMinutes: 30,
    cleaningFollowupGraceMinutes: 15,
  });
});
for (const [field, min, max] of [
  ["cleaningDurationCommitmentMinutes", 15, 1440],
  ["cleaningStartConfirmationGraceMinutes", 5, 240],
  ["cleaningFollowupGraceMinutes", 5, 240],
] as const) {
  test(`${field}: exact inclusive boundaries`, () => {
    for (const value of [min, max]) assert.deepEqual(parseCleaningTimingUpdate({ [field]: value }), { [field]: value });
  });
  for (const value of [min - 1, max + 1, 15.9, "15.9", "1e2", true, false, [], {}, NaN, Infinity]) {
    test(`${field}: rejects ${JSON.stringify(value)} (${typeof value})`, () => {
      assert.throws(() => parseCleaningTimingUpdate({ [field]: value }), CleaningTimingValidationError);
    });
  }
}
test("inherited fields and undefined values are not update requests", () => {
  const input: Record<string, unknown> = Object.create({ cleaningDurationCommitmentMinutes: 120 });
  input.cleaningFollowupGraceMinutes = undefined;
  assert.deepEqual(parseCleaningTimingUpdate(input), {});
});
