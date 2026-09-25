import assert from "node:assert/strict";
import test from "node:test";
import { isValidPropertyTime } from "../routes/dashboard.properties.route.js";

test("accepts valid HH:mm property checkout times", () => {
  for (const value of ["11:00", "10:30", "23:59", "00:00"]) {
    assert.equal(isValidPropertyTime(value), true, value);
  }
});

test("rejects invalid property checkout times", () => {
  for (const value of ["24:00", "11:60", "11", "text", ""]) {
    assert.equal(isValidPropertyTime(value), false, value);
  }
});
