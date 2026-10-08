import assert from "node:assert/strict";
import test from "node:test";
import { isOtaGuestExternalDeliveryBlocked } from "./ota-guest-external-messaging.policy.js";

const env = { OTA_GUEST_EXTERNAL_MESSAGING_BLOCKED_PROVIDERS: "AIRBNB,BOOKING_COM" } as NodeJS.ProcessEnv;
const ota = (source: string) => ({ source, externalProvider: "CHANNEX", externalId: "booking-123" });

for (const source of ["airbnb", "AIR_BNB", "BookingCom", "booking.com", "BOOKING_COM"]) {
  for (const channel of ["sms", "email"] as const) {
    test(`blocks ${source} ${channel}`, () => {
      assert.equal(isOtaGuestExternalDeliveryBlocked(ota(source), channel, env), true);
    });
  }
}
for (const source of ["VRBO", "EXPEDIA"]) {
  test(`preserves ${source} communications`, () => {
    assert.equal(isOtaGuestExternalDeliveryBlocked(ota(source), "sms", env), false);
    assert.equal(isOtaGuestExternalDeliveryBlocked(ota(source), "email", env), false);
  });
}
test("does not block Direct Booking even with an OTA-like source", () => {
  assert.equal(isOtaGuestExternalDeliveryBlocked({ source: "AIRBNB", externalProvider: "PIN_GO_DIRECT", externalId: null }, "sms", env), false);
});
test("does not block with an unset variable", () => {
  assert.equal(isOtaGuestExternalDeliveryBlocked(ota("AIRBNB"), "sms", {}), false);
});
test("does not trust missing external booking identity", () => {
  assert.equal(isOtaGuestExternalDeliveryBlocked({ source: "AIRBNB", externalProvider: "CHANNEX", externalId: null }, "sms", env), false);
});
