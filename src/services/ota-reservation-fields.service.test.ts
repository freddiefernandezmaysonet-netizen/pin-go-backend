import assert from "node:assert/strict";
import test from "node:test";
import { readChannexBookingFields } from "./ota-reservation-fields.service";

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
