import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");

const chargeMode = read("src/services/direct-booking-stripe-charge-mode.service.ts");
const publicBooking = read("src/routes/public-booking.routes.ts");
const modificationCheckout = read(
  "src/services/guest-reservation-modification-checkout.service.ts"
);
const modificationPayment = read(
  "src/services/guest-reservation-modification-payment.service.ts"
);
const refundService = read("src/services/direct-booking-refund.service.ts");
const stripeRefund = read(
  "src/services/direct-booking-stripe-refund.service.ts"
);

test("Direct Booking charge mode is Direct Charge only", () => {
  assert.doesNotMatch(chargeMode, /DESTINATION_CHARGE/);
  assert.match(chargeMode, /DIRECT_CHARGE/);
});

test("new Direct Booking checkout never creates transfer_data destination", () => {
  assert.doesNotMatch(
    publicBooking,
    /transfer_data\s*:\s*\{\s*destination\s*:/
  );
});

test("paid reservation modifications never create destination charges", () => {
  assert.doesNotMatch(
    modificationCheckout,
    /transfer_data\s*:\s*\{\s*destination\s*:/
  );
  assert.doesNotMatch(
    modificationPayment,
    /transfer_data\?\.destination/
  );
});

test("Direct Booking refunds never request reverse_transfer", () => {
  assert.doesNotMatch(refundService, /reverse_transfer\s*:/);
  assert.doesNotMatch(stripeRefund, /reverse_transfer/);
});

test("Direct Charge resource context remains explicit and connected-account scoped", () => {
  assert.match(chargeMode, /stripeAccount\s*:\s*connectedAccountId/);
});
