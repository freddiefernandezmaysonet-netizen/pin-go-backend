import test from "node:test";
import assert from "node:assert/strict";
import { calculateAccommodationDiscount as calculate, applyAccommodationDiscountToQuote, discountConfigSchema, defaultDiscountConfig, type DiscountConfig } from "./direct-booking-discounts.policy";
const rule = (type: "EARLY_BIRD" | "LENGTH_OF_STAY", threshold: number, percent: number, id = `${type}-${threshold}`) => ({
  id, type, enabled: true, threshold, percent, bookingFrom: null, bookingTo: null, stayFrom: null, stayTo: null, excludedDates: [],
});
const config: DiscountConfig = { ...defaultDiscountConfig, enabled: true, rules: [rule("EARLY_BIRD", 30, 10), rule("LENGTH_OF_STAY", 7, 5)] };
const input = { config, subtotal: 1000, checkIn: new Date("2027-01-01T20:00:00Z"), now: new Date("2026-12-02T14:00:00Z"), timeZone: "America/Puerto_Rico",
  stayDates: Array.from({ length: 7 }, (_, i) => `2027-01-0${i + 1}`) };
test("disabled configuration leaves accommodation untouched", () => assert.equal(calculate({ ...input, config: { ...config, enabled: false } }).accommodationDiscountTotal, 0));
test("early bird boundary uses property calendar days, including Puerto Rico midnight", () => {
  assert.equal(calculate(input).accommodationDiscountTotal, 100);
  assert.equal(calculate({ ...input, now: new Date("2026-12-03T03:59:00Z") }).accommodationDiscountTotal, 100);
  assert.equal(calculate({ ...input, now: new Date("2026-12-03T04:00:00Z") }).accommodationDiscountTotal, 50);
});
test("length of stay threshold is inclusive", () => {
  const conf = { ...config, rules: [rule("LENGTH_OF_STAY", 7, 5)] };
  assert.equal(calculate({ ...input, config: conf }).accommodationDiscountTotal, 50);
  assert.equal(calculate({ ...input, stayDates: input.stayDates.slice(0, 6), config: conf }).accommodationDiscountTotal, 0);
});
test("only highest qualifying level of each type applies", () => {
  const result = calculate({ ...input, config: { ...config, rules: [rule("LENGTH_OF_STAY", 5, 20), rule("LENGTH_OF_STAY", 7, 10)] } });
  assert.equal(result.accommodationDiscountTotal, 100); assert.equal(result.discounts.length, 1);
});
test("stacking 10% and 5% produces 14.5%", () => assert.equal(calculate({ ...input, config: { ...config, combination: "STACK" } }).accommodationDiscountTotal, 145));
test("maximum discount and final average floor constrain total", () => {
  assert.equal(calculate({ ...input, config: { ...config, combination: "STACK", maxDiscountPercent: 12 } }).accommodationDiscountTotal, 120);
  assert.equal(calculate({ ...input, config: { ...config, minimumFinalNightlyRate: 140 } }).accommodationDiscountTotal, 20);
  assert.equal(calculate({ ...input, config: { ...config, minimumFinalNightlyRate: 200 } }).accommodationDiscountTotal, 0);
});
test("booking window and all occupied nights must qualify, not checkout", () => {
  const run = (patch: object) => calculate({ ...input, config: { ...config, rules: [{ ...rule("LENGTH_OF_STAY", 7, 10), ...patch }] } }).accommodationDiscountTotal;
  assert.equal(run({ bookingFrom: "2026-12-03" }), 0); assert.equal(run({ bookingTo: "2026-12-01" }), 0);
  assert.equal(run({ stayTo: "2027-01-06" }), 0); assert.equal(run({ excludedDates: ["2027-01-04"] }), 0);
  assert.equal(run({ excludedDates: ["2027-01-08"] }), 100);
});
test("discount is on subtotal only; fees and nightly rates stay intact and tax base reduces", () => {
  const pricing = { nightlySubtotal: 1000, nightlyRates: [{ rate: 1000 }], cleaningFee: 75, amenitiesTotal: 25,
    taxes: [{ id: "tax", name: "Tax", percentage: 7, amount: 77 }] };
  const result = applyAccommodationDiscountToQuote(pricing, calculate(input));
  assert.equal(result.nightlySubtotal, 1000); assert.deepEqual(result.nightlyRates, [{ rate: 1000 }]);
  assert.equal(result.cleaningFee, 75); assert.equal(result.amenitiesTotal, 25);
  assert.equal(result.taxableSubtotal, 1000); assert.equal(result.taxesTotal, 70); assert.equal(result.totalAmountCents, 107000);
});
test("cent rounding never exceeds configured cap", () => {
  const result = calculate({ ...input, subtotal: 10.01, config: { ...config, maxDiscountPercent: 3, rules: [rule("LENGTH_OF_STAY", 1, 50)] } });
  assert.equal(result.accommodationDiscountTotal, 0.30); assert.equal(result.accommodationSubtotalAfterDiscount, 9.71);
});
test("invalid percentages, thresholds, dates and duplicate ids rejected", () => {
  for (const patch of [{ percent: 101 }, { percent: -1 }, { threshold: 0 }, { threshold: 2.5 }, { bookingFrom: "2027-02-30" }, { stayFrom: "2027-02-01", stayTo: "2027-01-01" }]) {
    assert.equal(discountConfigSchema.safeParse({ ...config, rules: [{ ...rule("EARLY_BIRD", 30, 10), ...patch }] }).success, false);
  }
  assert.equal(discountConfigSchema.safeParse({ ...config, rules: [config.rules[0], config.rules[0]] }).success, false);
});
