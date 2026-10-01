import assert from "node:assert/strict";
import test from "node:test";
import { resolveOtaPropertyType } from "./ota-property-type.policy.js";

test("listing types select an explicit billing category", () => {
  for (const [listing, type] of Object.entries({ HOUSE: "holiday_home", APARTMENT: "apartment", CONDO: "apartment", CABIN: "chalet", COTTAGE: "country_house", VILLA: "villa", TOWNHOUSE: "holiday_home", BUNGALOW: "holiday_home", LOFT: "apartment", STUDIO: "apartment", FARM_STAY: "farm_stay" })) {
    assert.deepEqual(resolveOtaPropertyType(listing), { type, category: "vacation_rental" });
  }
  assert.deepEqual(resolveOtaPropertyType("GUESTHOUSE"), { type: "guest_house", category: "hotel" });
});

test("missing, ambiguous and unknown types never default to hotel", () => {
  for (const value of [null, undefined, "", "OTHER", "HOTEL", "toString", 42]) {
    assert.throws(() => resolveOtaPropertyType(value), /OTA_PROPERTY_TYPE_REQUIRED/);
  }
});
