import test from "node:test";
import assert from "node:assert/strict";
import { validatePaidPricingSnapshot as validate } from "./direct-booking-pricing-snapshot.policy";
const payment = { propertyId: "p1", checkIn: new Date("2027-01-01"), checkOut: new Date("2027-01-08"), amountTotal: 90000, currency: "usd" };
const pricing = { totalAmountCents: 90000, totalAmount: 900, currency: "usd", accommodationDiscountTotal: 100, discountPolicySnapshot: { enabled: true } };
const snapshot = { ...payment, pricing };
test("paid snapshot preserves original discounts without recalculation", () => assert.equal(validate(snapshot, payment), pricing));
test("missing snapshot must fail rather than recalculate a paid booking", () => assert.throws(() => validate(null, payment), /SNAPSHOT_MISMATCH/));
test("different property or dates cannot reuse snapshot", () => {
  assert.throws(() => validate({ ...snapshot, propertyId: "p2" }, payment), /SNAPSHOT_MISMATCH/);
  assert.throws(() => validate({ ...snapshot, checkOut: new Date("2027-01-09") }, payment), /SNAPSHOT_MISMATCH/);
});
test("snapshot total and currency must match actual Stripe payment", () => {
  assert.throws(() => validate(snapshot, { ...payment, amountTotal: 89999 }), /PAID_AMOUNT_MISMATCH/);
  assert.throws(() => validate(snapshot, { ...payment, currency: "eur" }), /PAID_AMOUNT_MISMATCH/);
  assert.throws(() => validate({ ...snapshot, pricing: { ...pricing, totalAmount: 1000 } }, payment), /PAID_AMOUNT_MISMATCH/);
});
