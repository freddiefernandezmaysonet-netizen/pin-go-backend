import assert from "node:assert/strict";
import test from "node:test";
import { Prisma, type Reservation } from "@prisma/client";
import { extensionStateFingerprint, reservationStateFingerprint } from "./reservation-state-fingerprint.js";

const fixture = Object.fromEntries(Object.values(Prisma.ReservationScalarFieldEnum)
  .map(field => [field, null])) as unknown as Reservation;

test("only the four audited watchdog bookkeeping fields can change without invalidating state", () => {
  const original = reservationStateFingerprint(fixture);
  const ignored = new Set(["updatedAt", "lastReconciledAt", "lastReconciledCheckIn", "lastReconciledCheckOut"]);
  for (const field of Object.values(Prisma.ReservationScalarFieldEnum)) {
    const changed = reservationStateFingerprint({ ...fixture, [field]: "changed" });
    assert.equal(changed === original, ignored.has(field), field);
  }
});

test("JSON key order and Decimal serialization are stable; related records do not enter the scalar digest", () => {
  const one = { ...fixture, totalAmount: new Prisma.Decimal("3.35"), pricingBreakdown: { a: 1, b: [2, 3] } };
  const two = { ...fixture, totalAmount: new Prisma.Decimal("3.350"), pricingBreakdown: { b: [2, 3], a: 1 }, property: { name: "ignored relation" } };
  assert.equal(reservationStateFingerprint(one), reservationStateFingerprint(two));
  assert.notEqual(reservationStateFingerprint(one), reservationStateFingerprint({ ...one, pricingBreakdown: { a: 1, b: [3, 2] } }));
});

test("only explicit extension evidence opts into the new guard; legacy proposals keep timestamp checks", () => {
  const fingerprint = reservationStateFingerprint(fixture);
  assert.equal(extensionStateFingerprint({ operation: "EXTEND_CHECKOUT_ONLY", reservationStateFingerprint: fingerprint }), fingerprint);
  for (const terms of [null, {}, { reservationStateFingerprint: fingerprint },
    { operation: "EXTEND_CHECKOUT_ONLY", reservationStateFingerprint: "invalid" }]) {
    assert.equal(extensionStateFingerprint(terms), null);
  }
});
