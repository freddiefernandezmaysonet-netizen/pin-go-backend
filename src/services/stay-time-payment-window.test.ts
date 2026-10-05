import assert from "node:assert/strict";
import test from "node:test";
import { createStayTimePaymentDeadline, assertStayTimePaymentWindow } from "./stay-time-payment-window.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 1, 12) + seconds * 1000);
const base = {
  operation: "LATE_CHECKOUT" as const, proposedCheckIn: at(-86400), currentCheckOut: at(7200), guestTokenExpiresAt: null,
  quoteCreatedAt: at(0), quoteExpiresAt: at(60), confirmedAt: at(10), stagedAt: at(20),
  checkoutExpiresAt: at(3620), now: at(20), phase: "CHECKOUT_CREATION" as const,
};
test("staging freezes a one-hour deadline", () => {
  assert.equal(createStayTimePaymentDeadline(base).getTime(), at(3620).getTime());
  assert.doesNotThrow(() => assertStayTimePaymentWindow(base));
});
test("five-minute quotes can be confirmed after minute one without extending the payment deadline", () => {
  for (const phase of ["CHECKOUT_CREATION", "CHECKOUT_REPLAY", "PAYMENT_APPLICATION"] as const) {
    assert.doesNotThrow(() => assertStayTimePaymentWindow({ ...base, quoteExpiresAt: at(300),
      confirmedAt: at(240), stagedAt: at(250), now: at(260), checkoutExpiresAt: at(3850), phase }));
  }
  assert.throws(() => assertStayTimePaymentWindow({ ...base, quoteExpiresAt: at(300),
    confirmedAt: at(300), stagedAt: at(300), now: at(300) }), /INVALID_STAY_TIME_PAYMENT_WINDOW/);
});
test("early arrival, original checkout and guest-link expiry cap the payment deadline", () => {
  assert.equal(createStayTimePaymentDeadline({ ...base, operation: "EARLY_CHECKIN", proposedCheckIn: at(2500) }).getTime(), at(2500).getTime());
  assert.equal(createStayTimePaymentDeadline({ ...base, currentCheckOut: at(2500) }).getTime(), at(2500).getTime());
  assert.equal(createStayTimePaymentDeadline({ ...base, guestTokenExpiresAt: at(2400) }).getTime(), at(2400).getTime());
});
test("exact 31-minute setup boundary is rejected, not rounded up", () => {
  assert.throws(() => createStayTimePaymentDeadline({ ...base, currentCheckOut: at(1880) }), /WINDOW_TOO_SHORT/);
  assert.equal(createStayTimePaymentDeadline({ ...base, currentCheckOut: at(1881) }).getTime(), at(1881).getTime());
});
test("timely confirmed and staged consent survives quote expiry within its separate payment window", () => {
  assert.doesNotThrow(() => assertStayTimePaymentWindow({ ...base, now: at(120) }));
  assert.doesNotThrow(() => assertStayTimePaymentWindow({ ...base, now: at(3619), phase: "PAYMENT_APPLICATION" }));
});
test("existing payment window may continue while a new Checkout is no longer allowed", () => {
  assert.throws(() => assertStayTimePaymentWindow({ ...base, now: at(1800) }), /WINDOW_TOO_SHORT/);
  assert.doesNotThrow(() => assertStayTimePaymentWindow({ ...base, now: at(1800), phase: "PAYMENT_APPLICATION" }));
});
for (const [name, changes] of [
  ["late confirmation", { confirmedAt: at(60) }],
  ["late staging", { stagedAt: at(60), now: at(60) }],
  ["confirmation before quote", { confirmedAt: at(-1) }],
  ["staging before confirmation", { stagedAt: at(5) }],
  ["future staging", { now: at(19) }],
  ["overlong quote", { quoteExpiresAt: at(301) }],
  ["extended deadline", { checkoutExpiresAt: at(3621) }],
  ["checkout cutoff", { currentCheckOut: at(3619) }],
  ["expired guest link", { guestTokenExpiresAt: at(100) }],
  ["invalid date", { stagedAt: new Date(NaN) }],
] as const) {
  test(`rejects ${name}`, () => assert.throws(() => assertStayTimePaymentWindow({ ...base, ...changes }), /INVALID_STAY_TIME_PAYMENT_WINDOW/));
}
test("payment application at or after the deadline remains blocked", () => {
  for (const seconds of [3620, 3621]) assert.throws(() => assertStayTimePaymentWindow({ ...base, now: at(seconds), phase: "PAYMENT_APPLICATION" }), /WINDOW_EXPIRED/);
});
