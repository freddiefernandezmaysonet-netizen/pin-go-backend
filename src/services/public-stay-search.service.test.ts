import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePublicStaySearchText,
  parsePublicStayDateKey,
  validatePublicStaySearchInput,
} from "./public-stay-search.service";

test("normalizes case accents and whitespace", () => {
  assert.equal(normalizePublicStaySearchText("  ÍSA  "), "isa");
});

test("accepts valid date keys and rejects invalid calendar dates", () => {
  assert.equal(parsePublicStayDateKey("2026-10-10"), "2026-10-10");
  assert.equal(parsePublicStayDateKey("2026-02-30"), null);
});

test("requires checkout after checkin", () => {
  const result = validatePublicStaySearchInput({
    destination: "Isabela",
    checkIn: "2099-10-10",
    checkOut: "2099-10-10",
    guests: 2,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "CHECK_OUT_MUST_FOLLOW_CHECK_IN");
});

test("rejects invalid guest counts", () => {
  const result = validatePublicStaySearchInput({
    destination: "Isabela",
    checkIn: "2099-10-10",
    checkOut: "2099-10-11",
    guests: 0,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "INVALID_GUEST_COUNT");
});
