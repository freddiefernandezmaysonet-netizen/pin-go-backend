import test from "node:test";
import assert from "node:assert/strict";
import { parseCleanerTaskFilters } from "./cleaner-task-pagination.service.js";
test("cleaner filters accept bounded literal search and inclusive real dates", () => {
  assert.deepEqual(parseCleanerTaskFilters({ q: "  Casa 100%_  ", status: "IN_PROGRESS", from: "2026-10-07", to: "2026-10-07" }), { q: "Casa 100%_", status: "IN_PROGRESS", from: "2026-10-07", to: "2026-10-07" });
  assert.deepEqual(parseCleanerTaskFilters({ q: "  ", status: "", view: "history" }), {});
  assert.deepEqual(parseCleanerTaskFilters({ propertyId: "own-property" }), { propertyId: "own-property" });
  assert.deepEqual(parseCleanerTaskFilters({ from: "2028-02-29" }), { from: "2028-02-29" });
});
test("cleaner filters reject invalid states, dates, ranges and repeated query values", () => {
  for (const invalid of [{ q: "x".repeat(101) }, { status: "UNKNOWN" }, { from: "2026-02-29" }, { from: "2026-04-31" }, { to: "2026-1-01" }, { from: "0000-01-01" }, { from: "2026-10-08", to: "2026-10-07" }, { q: ["a", "b"] }, { status: {} }, { propertyId: ["a", "b"] }, { propertyId: "x".repeat(201) }]) assert.throws(() => parseCleanerTaskFilters(invalid), /CLEANING_FILTER_INVALID/);
});
