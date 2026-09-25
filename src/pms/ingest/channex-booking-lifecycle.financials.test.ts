import assert from "node:assert/strict";
import test from "node:test";
import { resolveBookingFinancials } from "./channex-booking-lifecycle.service.js";

function revision(raw: Record<string, unknown>) {
  return { reservation: { raw } } as any;
}

test("maps Channex Total booking amount and currency without cents conversion", () => {
  assert.deepEqual(resolveBookingFinancials(revision({ amount: "311.80", currency: "usd" })), {
    totalAmount: 311.8,
    currency: "USD",
  });
});

test("preserves zero total and rejects invalid amount or currency", () => {
  assert.deepEqual(resolveBookingFinancials(revision({ amount: 0, currency: "USD" })), {
    totalAmount: 0,
    currency: "USD",
  });
  assert.deepEqual(resolveBookingFinancials(revision({ amount: "not-money", currency: "US" })), {
    totalAmount: null,
    currency: null,
  });
});

test("does not derive amountCollected from Channex booking amount", () => {
  const normalized = resolveBookingFinancials(
    revision({ amount: "977.65", currency: "USD", payment_collect: "ota" })
  );
  assert.deepEqual(normalized, { totalAmount: 977.65, currency: "USD" });
  assert.equal("amountCollected" in normalized, false);
});
