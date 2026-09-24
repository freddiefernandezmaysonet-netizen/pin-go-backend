import assert from "node:assert/strict";
import test from "node:test";
import { readChannexBookingFields } from "./ota-reservation-fields.service";

test("invalid amounts remain unknown instead of becoming a payment value", () => {
  for (const amount of ["", "   ", false, true, [], {}, null, undefined, NaN, Infinity, -1, "-1", "0x10", "1e3"]) {
    assert.equal(readChannexBookingFields({ provider: "CHANNEX", booking: { amount } }).totalAmount, null);
  }
});

test("valid zero and decimal booking amounts are preserved", () => {
  for (const [amount, expected] of [[0, 0], ["0", 0], [125.4, 125.4], [" 125.40 ", 125.4]] as const) {
    assert.equal(readChannexBookingFields({ provider: "CHANNEX", booking: { amount } }).totalAmount, expected);
  }
});

test("preserved Channex revision supplies guest contact and booking money", () => {
  assert.deepEqual(readChannexBookingFields({
    provider: "CHANNEX",
    booking: {
      customer: { mail: "guest@example.com", phone: "+17875550123" },
      amount: "125.40",
      currency: "USD",
      payment_collect: "ota",
    },
  }), {
    guestEmail: "guest@example.com",
    guestPhone: "+17875550123",
    totalAmount: 125.4,
    currency: "usd",
  });
});

test("missing OTA contact and amount remain unknown", () => {
  assert.deepEqual(readChannexBookingFields({
    provider: "CHANNEX",
    booking: { customer: { mail: "", phone: "" }, currency: "invalid" },
  }), {
    guestEmail: null,
    guestPhone: null,
    totalAmount: null,
    currency: null,
  });
});

test("other reservation providers cannot inherit Channex fields", () => {
  assert.equal(readChannexBookingFields({
    provider: "LODGIFY",
    booking: { amount: "125.40", customer: { mail: "guest@example.com" } },
  }).totalAmount, null);
});
