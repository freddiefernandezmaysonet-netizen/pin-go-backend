import assert from "node:assert/strict";
import test from "node:test";
import { assertReviewStayEligible, hasConfirmedDirectBookingPayment, isCanonicalDirectBooking } from "./review-eligibility.policy.js";

const stay = { source: "DIRECT_BOOKING", externalProvider: "PIN_GO_DIRECT", status: "ACTIVE", cancelledAt: null, paymentState: "PAID", amountCollected: 300, checkOut: new Date("2026-09-01T15:00:00Z") };

test("requires the exact canonical direct-booking source pair", () => {
  assert.equal(isCanonicalDirectBooking(stay), true);
  assert.equal(isCanonicalDirectBooking({ ...stay, source: "MANUAL" }), false);
  assert.equal(isCanonicalDirectBooking({ ...stay, externalProvider: "OTHER" }), false);
});

test("keeps completed refunded stays eligible when money was originally collected", () => {
  assert.doesNotThrow(() => assertReviewStayEligible({ ...stay, paymentState: "REFUNDED" }, { requireCheckoutCompleted: true, now: new Date("2026-09-02T00:00:00Z") }));
  assert.equal(hasConfirmedDirectBookingPayment({ ...stay, paymentState: "PARTIALLY_REFUNDED" }), true);
  assert.throws(() => assertReviewStayEligible({ ...stay, amountCollected: 0 }, { requireCheckoutCompleted: true, now: new Date("2026-09-02T00:00:00Z") }), /confirmed direct-booking payment/);
});

test("allows invitation creation before checkout but blocks submission until checkout", () => {
  const futureStay = { ...stay, checkOut: new Date("2026-09-05T15:00:00Z") };
  const now = new Date("2026-09-02T00:00:00Z");

  assert.doesNotThrow(() => assertReviewStayEligible(futureStay, { requireCheckoutCompleted: false, now }));
  assert.throws(
    () => assertReviewStayEligible(futureStay, { requireCheckoutCompleted: true, now }),
    /has not completed/,
  );
});

test("rejects cancelled, non-active and unpaid reservations", () => {
  const now = new Date("2026-09-02T00:00:00Z");
  assert.throws(() => assertReviewStayEligible({ ...stay, status: "CANCELLED" }, { requireCheckoutCompleted: true, now }), /Cancelled stays/);
  assert.throws(() => assertReviewStayEligible({ ...stay, cancelledAt: new Date("2026-08-30T00:00:00Z") }, { requireCheckoutCompleted: true, now }), /Cancelled stays/);
  assert.throws(() => assertReviewStayEligible({ ...stay, paymentState: "PENDING" }, { requireCheckoutCompleted: true, now }), /confirmed direct-booking payment/);
});
