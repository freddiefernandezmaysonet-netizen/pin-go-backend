import assert from "node:assert/strict";
import test from "node:test";

import { requireIanaTimezone } from "./iana-timezone";

test("accepts property-specific IANA timezones without a Puerto Rico default", () => {
  assert.equal(requireIanaTimezone("America/Puerto_Rico"), "America/Puerto_Rico");
  assert.equal(requireIanaTimezone("Europe/Madrid"), "Europe/Madrid");
  assert.equal(requireIanaTimezone("America/New_York"), "America/New_York");
});

test("fails closed when the property timezone is missing", () => {
  assert.throws(() => requireIanaTimezone(null), /PROPERTY_TIMEZONE_REQUIRED/);
  assert.throws(() => requireIanaTimezone("  "), /PROPERTY_TIMEZONE_REQUIRED/);
});

test("fails closed when the property timezone is invalid", () => {
  assert.throws(
    () => requireIanaTimezone("America/Definitely_Not_A_Zone"),
    /PROPERTY_TIMEZONE_INVALID/
  );
});

test("supports domain-specific error codes", () => {
  assert.throws(
    () =>
      requireIanaTimezone(null, {
        required: "CHANNEX_ARI_PROPERTY_TIMEZONE_REQUIRED",
        invalid: "CHANNEX_ARI_PROPERTY_TIMEZONE_INVALID",
      }),
    /CHANNEX_ARI_PROPERTY_TIMEZONE_REQUIRED/
  );
});
