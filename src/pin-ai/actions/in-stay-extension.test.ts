import assert from "node:assert/strict";
import test from "node:test";
import {
  InStayExtensionError,
  planInStayExtension,
  quoteInStayExtension,
} from "./in-stay-extension.js";

function stay(): Parameters<typeof planInStayExtension>[0] {
  return {
    reservation: {
      status: "ACTIVE", paymentState: "PAID", source: "DIRECT_BOOKING", externalProvider: null,
      checkIn: new Date("2026-09-26T18:17:03.123Z"), // persisted early/custom arrival
      checkOut: new Date("2026-09-27T15:00:00.000Z"),
      adults: 2, children: 0, selectedAmenityIds: ["breakfast"],
    },
    now: new Date("2026-09-26T22:00:00Z"), proposedCheckOutDate: "2026-09-28",
    propertyTimezone: "America/Puerto_Rico", propertyCheckOutTime: "11:00", maximumNights: 30,
  };
}

function quote(): Parameters<typeof quoteInStayExtension>[0] {
  return {
    plan: planInStayExtension(stay()), currentTotalAmountCents: 335,
    currency: "usd", pricingCurrency: "usd",
    nightlyRates: [{ date: "2026-09-27", amountCents: 100 }],
    amenities: [{ id: "breakfast", chargeMode: "OPTIONAL", feeType: "PER_NIGHT", unitAmountCents: 0 }],
    taxes: [{ id: "tax", rateBasisPoints: 1200 }],
  };
}

function rejectsCode(run: () => unknown, code: string) {
  assert.throws(run, (error: unknown) => error instanceof InStayExtensionError && error.code === code);
}

test("preserves the exact original check-in and guest configuration for an active extension", () => {
  const input = stay();
  const before = JSON.stringify(input);
  const plan = planInStayExtension(input);
  assert.equal(plan.operation, "EXTEND_CHECKOUT_ONLY");
  assert.equal(plan.checkIn, "2026-09-26T18:17:03.123Z");
  assert.equal(plan.proposedCheckOut, "2026-09-28T15:00:00.000Z");
  assert.equal(plan.totalNights, 2);
  assert.equal(plan.additionalNights, 1);
  assert.deepEqual(plan.additionalNightDates, ["2026-09-27"]);
  assert.equal(plan.adults, 2);
  assert.equal(plan.children, 0);
  assert.deepEqual(plan.selectedAmenityIds, ["breakfast"]);
  assert.equal(JSON.stringify(input), before);
});

test("eligibility is bounded by persisted instants, including exact check-in and checkout", () => {
  const input = stay();
  assert.doesNotThrow(() => planInStayExtension({ ...input, now: input.reservation.checkIn }));
  assert.doesNotThrow(() => planInStayExtension({ ...input, now: new Date(input.reservation.checkOut.getTime() - 1) }));
  rejectsCode(() => planInStayExtension({ ...input, now: new Date(input.reservation.checkIn.getTime() - 1) }), "EXTENSION_REQUIRES_IN_STAY");
  rejectsCode(() => planInStayExtension({ ...input, now: input.reservation.checkOut }), "CURRENT_STAY_ENDED");
  rejectsCode(() => planInStayExtension({ ...input, now: new Date("2026-09-28T16:00:00Z") }), "CURRENT_STAY_ENDED");
});

for (const override of [{ status: "CANCELLED" }, { paymentState: "NONE" }, { paymentState: "PARTIALLY_REFUNDED" }]) {
  test(`rejects ineligible persisted state ${JSON.stringify(override)}`, () => {
    const input = stay();
    rejectsCode(() => planInStayExtension({ ...input, reservation: { ...input.reservation, ...override } }), "RESERVATION_NOT_ELIGIBLE_FOR_EXTENSION");
  });
}

test("rejects OTA reservations and accepts the canonical direct provider marker", () => {
  const input = stay();
  rejectsCode(() => planInStayExtension({ ...input, reservation: { ...input.reservation, source: "CHANNEX", externalProvider: "CHANNEX" } }), "NOT_DIRECT_BOOKING_RESERVATION");
  assert.doesNotThrow(() => planInStayExtension({ ...input, reservation: { ...input.reservation, source: null, externalProvider: "PIN_GO_DIRECT" } }));
});

test("rejects equal/earlier checkout, invalid calendar dates and invalid timezone", () => {
  for (const date of ["2026-09-27", "2026-09-26"]) {
    rejectsCode(() => planInStayExtension({ ...stay(), proposedCheckOutDate: date }), "CHECKOUT_EXTENSION_REQUIRED");
  }
  for (const date of ["2026-02-30", "2026-09-28T11:00", "September 28"]) {
    rejectsCode(() => planInStayExtension({ ...stay(), proposedCheckOutDate: date }), "INVALID_EXTENSION_DATE");
  }
  rejectsCode(() => planInStayExtension({ ...stay(), propertyTimezone: "Bad/Zone" }), "INVALID_EXTENSION_PROPERTY_TIME");
  rejectsCode(() => planInStayExtension({ ...stay(), propertyCheckOutTime: "25:00" }), "INVALID_EXTENSION_PROPERTY_TIME");
});

test("checks maximum nights against the entire stay, not only the added nights", () => {
  rejectsCode(() => planInStayExtension({ ...stay(), maximumNights: 1 }), "MAXIMUM_STAY_EXCEEDED");
  assert.doesNotThrow(() => planInStayExtension({ ...stay(), maximumNights: 2 }));
  rejectsCode(() => planInStayExtension({ ...stay(), maximumNights: 0 }), "INVALID_MAXIMUM_STAY");
});

test("counts local calendar nights across DST without 24-hour rounding errors", () => {
  const input = stay();
  const plan = planInStayExtension({ ...input,
    reservation: { ...input.reservation, checkIn: new Date("2026-10-30T20:00:00Z"), checkOut: new Date("2026-10-31T15:00:00Z") },
    now: new Date("2026-10-31T14:00:00Z"), proposedCheckOutDate: "2026-11-02", propertyTimezone: "America/New_York",
  });
  assert.equal(plan.additionalNights, 2);
  assert.deepEqual(plan.additionalNightDates, ["2026-10-31", "2026-11-01"]);
  assert.equal(plan.proposedCheckOut, "2026-11-02T16:00:00.000Z");
});

test("uses local checkout day instead of UTC day for the extension's first night", () => {
  const input = stay();
  const plan = planInStayExtension({ ...input,
    reservation: { ...input.reservation, checkIn: new Date("2026-09-26T04:00:00Z"), checkOut: new Date("2026-09-27T23:00:00Z") },
    now: new Date("2026-09-26T22:00:00Z"), proposedCheckOutDate: "2026-09-29", propertyTimezone: "Pacific/Auckland", propertyCheckOutTime: "12:00",
  });
  assert.deepEqual(plan.additionalNightDates, ["2026-09-28"]);
});

test("rejects nonexistent local checkout times during the DST spring gap", () => {
  const input = stay();
  rejectsCode(() => planInStayExtension({ ...input,
    reservation: { ...input.reservation, checkIn: new Date("2026-03-06T21:00:00Z"), checkOut: new Date("2026-03-07T16:00:00Z") },
    now: new Date("2026-03-07T12:00:00Z"), proposedCheckOutDate: "2026-03-08", propertyTimezone: "America/New_York", propertyCheckOutTime: "02:30",
  }), "INVALID_EXTENSION_PROPERTY_TIME");
});

test("reproduces the reported arithmetic as a fixture without a live price claim", () => {
  const result = quoteInStayExtension(quote());
  assert.equal(result.currentTotalAmountCents, 335);
  assert.equal(result.amountDifferenceCents, 112);
  assert.equal(result.proposedTotalAmountCents, 447);
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.actionExecuted, false);
  assert.equal(result.availabilityHeld, false);
});

test("preserves the contracted total independently of historical nightly repricing", () => {
  const input = quote();
  const first = quoteInStayExtension({ ...input, currentTotalAmountCents: 10_000 });
  const second = quoteInStayExtension({ ...input, currentTotalAmountCents: 25_000 });
  assert.equal(first.amountDifferenceCents, 112);
  assert.equal(second.amountDifferenceCents, 112);
  assert.equal(first.proposedTotalAmountCents, 10_112);
  assert.equal(second.proposedTotalAmountCents, 25_112);
});

test("charges only selected/required per-night amenities and does not duplicate fixed fees", () => {
  const input = quote();
  const result = quoteInStayExtension({ ...input, amenities: [
    { id: "breakfast", chargeMode: "OPTIONAL", feeType: "PER_NIGHT", unitAmountCents: 500 },
    { id: "required", chargeMode: "REQUIRED", feeType: "PER_NIGHT", unitAmountCents: 200 },
    { id: "fixed", chargeMode: "REQUIRED", feeType: "PER_STAY", unitAmountCents: 9000 },
    { id: "included", chargeMode: "INCLUDED", feeType: "PER_NIGHT", unitAmountCents: 1000 },
    { id: "unselected", chargeMode: "OPTIONAL", feeType: "PER_NIGHT", unitAmountCents: 3000 },
  ] });
  assert.equal(result.cleaningFeeCents, 0);
  assert.equal(result.amenitiesTotalCents, 700);
  assert.equal(result.taxesTotalCents, 96);
  assert.equal(result.amountDifferenceCents, 896);
});

test("rejects missing, duplicate, extra and historical nightly rates", () => {
  for (const nightlyRates of [[], [{ date: "2026-09-26", amountCents: 100 }],
    [{ date: "2026-09-27", amountCents: 100 }, { date: "2026-09-27", amountCents: 100 }]]) {
    rejectsCode(() => quoteInStayExtension({ ...quote(), nightlyRates }), "EXTENSION_NIGHTLY_RATES_MISMATCH");
  }
});

test("calculates two added nights and per-night amenities without charging a second stay fee", () => {
  const input = quote();
  const result = quoteInStayExtension({ ...input,
    plan: planInStayExtension({ ...stay(), proposedCheckOutDate: "2026-09-29" }),
    nightlyRates: [{ date: "2026-09-28", amountCents: 200 }, { date: "2026-09-27", amountCents: 100 }],
    amenities: [
      { id: "breakfast", chargeMode: "OPTIONAL", feeType: "PER_NIGHT", unitAmountCents: 50 },
      { id: "fixed", chargeMode: "REQUIRED", feeType: "PER_STAY", unitAmountCents: 10_000 },
    ],
  });
  assert.equal(result.nightlySubtotalCents, 300);
  assert.equal(result.amenitiesTotalCents, 100);
  assert.equal(result.taxesTotalCents, 48);
  assert.equal(result.amountDifferenceCents, 448);
  assert.equal(result.proposedTotalAmountCents, 783);
});

test("fails closed for selected per-guest charges whose extension semantics are not certified", () => {
  for (const feeType of ["PER_GUEST", "PER_GUEST_PER_NIGHT"] as const) {
    rejectsCode(() => quoteInStayExtension({ ...quote(), amenities: [
      { id: "breakfast", chargeMode: "OPTIONAL", feeType, unitAmountCents: 50 },
    ] }), "EXTENSION_AMENITY_REVIEW_REQUIRED");
  }
});

test("rejects missing selected amenities, duplicate fees and duplicate taxes", () => {
  const input = quote();
  rejectsCode(() => quoteInStayExtension({ ...input, amenities: [] }), "EXTENSION_AMENITIES_MISMATCH");
  rejectsCode(() => quoteInStayExtension({ ...input, amenities: [...input.amenities, ...input.amenities] }), "EXTENSION_AMENITIES_MISMATCH");
  rejectsCode(() => quoteInStayExtension({ ...input, taxes: [...input.taxes, ...input.taxes] }), "INVALID_EXTENSION_TAX");
});

test("rounds each tax in integer cents and rejects invalid money/currency", () => {
  const input = quote();
  const result = quoteInStayExtension({ ...input, nightlyRates: [{ date: "2026-09-27", amountCents: 1 }], taxes: [{ id: "one", rateBasisPoints: 5000 }, { id: "two", rateBasisPoints: 5000 }] });
  assert.equal(result.taxesTotalCents, 2);
  for (const amount of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    rejectsCode(() => quoteInStayExtension({ ...input, currentTotalAmountCents: amount }), "INVALID_EXTENSION_AMOUNT");
  }
  rejectsCode(() => quoteInStayExtension({ ...input, currentTotalAmountCents: Number.MAX_SAFE_INTEGER }), "EXTENSION_AMOUNT_OVERFLOW");
  rejectsCode(() => quoteInStayExtension({ ...input, currency: "eur" }), "EXTENSION_CURRENCY_UNSUPPORTED");
  rejectsCode(() => quoteInStayExtension({ ...input, pricingCurrency: "eur" }), "EXTENSION_CURRENCY_UNSUPPORTED");
});

test("zero additional price does not create a refund or grant execution authority", () => {
  const result = quoteInStayExtension({ ...quote(), nightlyRates: [{ date: "2026-09-27", amountCents: 0 }] });
  assert.equal(result.financialAction, "NO_PAYMENT_REQUIRED");
  assert.equal(result.proposedTotalAmountCents, 335);
  assert.equal(result.actionExecuted, false);
});
