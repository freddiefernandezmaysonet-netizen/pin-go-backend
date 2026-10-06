import assert from "node:assert/strict";
import test from "node:test";
import { pinAIFeeBookingKind, recordPinAIReservationFee } from "./reservation-fee.service.js";

test("reservation fee includes every origin independently of channel messaging, excluding demos", () => {
  for (const [source, provider, expected] of [
    ["DIRECT_BOOKING", "PIN_GO_DIRECT", "DIRECT_BOOKING"], ["Airbnb", "CHANNEX", "OTA"],
    ["Booking.com", "CHANNEX", "OTA"], ["Expedia", "CHANNEX", "OTA"],
    ["VRBO", "CHANNEX", "OTA"], ["MANUAL", null, "OTHER"], ["DIRECT_BOOKING", null, "DIRECT_BOOKING"],
    ["INTERNAL_DEMO_DIRECT_BOOKING", "PIN_GO_INTERNAL_DEMO", null], [null, "CHANNEX", "OTA"],
  ] as const) assert.equal(pinAIFeeBookingKind({ source, externalProvider: provider }), expected);
});
test("fee recording defaults off without accessing the database", async () => {
  assert.equal(await recordPinAIReservationFee({} as never, {}, {
    organizationId: "org", propertyId: "property", reservationId: "reservation",
  }), "DISABLED");
});
