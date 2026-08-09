import assert from "node:assert/strict";
import test from "node:test";

import { resolveChannexAriPropertyChangedFields } from "./channex-ari-property-change.policy";

test("certification #2 classifies a property pricing change as rate-only", () => {
  assert.deepEqual(
    resolveChannexAriPropertyChangedFields({
      existing: { baseNightlyRate: 100, minimumNights: 2, maximumNights: 14 },
      changes: { baseNightlyRate: 125 },
    }),
    ["rate"]
  );
});

test("certification #5 classifies minimum nights as only supported min-stay fields", () => {
  assert.deepEqual(
    resolveChannexAriPropertyChangedFields({
      existing: { baseNightlyRate: 100, minimumNights: 2, maximumNights: 14 },
      changes: { minimumNights: 3 },
    }),
    ["minStayArrival", "minStayThrough"]
  );
});

test("classifies maximum nights as max-stay only", () => {
  assert.deepEqual(
    resolveChannexAriPropertyChangedFields({
      existing: { baseNightlyRate: 100, minimumNights: 2, maximumNights: 14 },
      changes: { maximumNights: 10 },
    }),
    ["maxStay"]
  );
});

test("certification #7 returns a deterministic union of only changed restrictions", () => {
  assert.deepEqual(
    resolveChannexAriPropertyChangedFields({
      existing: { baseNightlyRate: 100, minimumNights: 2, maximumNights: 14 },
      changes: { maximumNights: 10, baseNightlyRate: 125, minimumNights: 3 },
    }),
    ["rate", "minStayArrival", "minStayThrough", "maxStay"]
  );
});

test("ignores unchanged and non-ARI property fields", () => {
  assert.deepEqual(
    resolveChannexAriPropertyChangedFields({
      existing: { baseNightlyRate: 100, minimumNights: 2, name: "Casa" },
      changes: { baseNightlyRate: 100, name: "Casa Nueva" },
    }),
    []
  );
});
