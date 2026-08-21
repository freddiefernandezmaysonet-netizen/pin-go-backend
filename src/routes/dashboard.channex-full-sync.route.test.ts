import assert from "node:assert/strict";
import test from "node:test";

import { resolveFullSyncTodayDateKey } from "./dashboard.channex-full-sync.route";

const SAME_INSTANT = new Date("2026-08-21T02:00:00.000Z");

test("Full Sync derives today from the Puerto Rico property timezone", () => {
  assert.equal(
    resolveFullSyncTodayDateKey(SAME_INSTANT, "America/Puerto_Rico"),
    "2026-08-20"
  );
});

test("Full Sync derives today independently from a positive-offset property timezone", () => {
  assert.equal(
    resolveFullSyncTodayDateKey(SAME_INSTANT, "Europe/Madrid"),
    "2026-08-21"
  );
});

test("Full Sync fails closed when property timezone is missing", () => {
  assert.throws(
    () => resolveFullSyncTodayDateKey(SAME_INSTANT, null),
    /PROPERTY_TIMEZONE_REQUIRED/
  );
});

test("Full Sync fails closed when property timezone is invalid", () => {
  assert.throws(
    () => resolveFullSyncTodayDateKey(SAME_INSTANT, "Not/A_Timezone"),
    /PROPERTY_TIMEZONE_INVALID/
  );
});
