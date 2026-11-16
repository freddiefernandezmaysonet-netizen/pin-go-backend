import assert from "node:assert/strict";
import test from "node:test";
import { bookingCampaignMetadata, paidBookingAttribution } from "./direct-booking-attribution.js";

test("only the supported campaign becomes persisted paid-booking evidence", () => {
  assert.deepEqual(paidBookingAttribution("precheckin_return_stay"), {
    source: "pingo", medium: "email", campaign: "precheckin_return_stay", method: "tagged_url_v1",
  });
  for (const value of [null, undefined, "", "other", {}, ["precheckin_return_stay"], "precheckin_return_stay "]) {
    assert.equal(paidBookingAttribution(value), null);
    assert.deepEqual(bookingCampaignMetadata(value, 24), { freeCancellationHoursBeforeCheckIn: "24" });
  }
});
test("campaign replaces one redundant metadata key without increasing the checkout key budget", () => {
  const tagged = bookingCampaignMetadata("precheckin_return_stay", 24);
  assert.deepEqual(tagged, { bookingCampaign: "precheckin_return_stay" });
  assert.equal(Object.keys(tagged).length, Object.keys(bookingCampaignMetadata(null, 24)).length);
});
