import assert from "node:assert/strict";
import test from "node:test";
import { revalidateStayTimeTerms } from "./stay-time-proposal.service.js";
import { priceStayTimeService } from "./stay-time-quote.service.js";
import { deriveStayTimeHourlyBasis } from "./stay-time-hourly-basis.js";
import { calculateStayTimeFee } from "../pin-ai/actions/stay-time-policy.js";
const created = new Date("2026-10-05T01:00:00Z");
const at = (seconds: number) => new Date(created.getTime() + seconds * 1000);
test("five-minute consent reaches fresh reservation validation; expired and overlong terms do not", async () => {
  const freshRead = new Error("FRESH_RESERVATION_READ");
  let reads = 0;
  const db = { reservation: { async findFirst() { reads++; throw freshRead; } } };
  const validate = (ttl: number, elapsed: number) => revalidateStayTimeTerms({ db: db as never,
    guestToken: "synthetic-guest-token-12345", now: at(elapsed), expiresAt: at(ttl),
    termsSnapshot: { version: "stay_time_quote_v1", operation: "LATE_CHECKOUT", requestedLocalTime: "12:30",
      createdAt: created.toISOString(), expiresAt: at(ttl).toISOString() } }, "0");
  // The sentinel proves the temporal gate requires a fresh database read,
  // rather than accepting consent from the old quote alone.
  for (const elapsed of [0, 61, 240, 299]) await assert.rejects(validate(300, elapsed), error => error === freshRead);
  await assert.rejects(validate(60, 30), error => error === freshRead);
  assert.equal(reads, 5);
  for (const [ttl, elapsed] of [[300, 300], [301, 0], [60, 61]]) {
    await assert.rejects(validate(ttl!, elapsed!), /STAY_TIME_QUOTE_EXPIRED/);
  }
  assert.equal(reads, 5);
});


test("automatic rate uses first/last booked night and nominal 20/19-hour denominator", () => {
  const data = { checkIn: new Date("2026-10-01T19:00Z"), checkOut: new Date("2026-10-03T15:00Z"),
    timezone: "America/Puerto_Rico", standardCheckIn: "15:00", standardCheckOut: "11:00",
    pricingBreakdown: { currency: "USD", nightlyRates: [{ date: "2026-10-01", rate: 100 }, { date: "2026-10-02", rate: 200 }] } };
  const early = deriveStayTimeHourlyBasis({ ...data, operation: "EARLY_CHECKIN" });
  const late = deriveStayTimeHourlyBasis({ ...data, operation: "LATE_CHECKOUT", standardCheckIn: "16:00" });
  assert.deepEqual(early, { nightDate: "2026-10-01", nightlyAmountMinor: 10000, standardStayMinutes: 1200 });
  assert.deepEqual(late, { nightDate: "2026-10-02", nightlyAmountMinor: 20000, standardStayMinutes: 1140 });
  assert.equal(calculateStayTimeFee({ mode: "PER_HOUR", amountMinor: 0, currency: "USD" }, 90, early), 800);
  assert.equal(calculateStayTimeFee({ mode: "PER_HOUR", amountMinor: 0, currency: "USD" }, 90, late), 1600);
  for (const pricingBreakdown of [null, {}, { ...data.pricingBreakdown, nightlyRates: [] },
    { ...data.pricingBreakdown, nightlyRates: [data.pricingBreakdown.nightlyRates[0], data.pricingBreakdown.nightlyRates[0]] }]) {
    assert.throws(() => deriveStayTimeHourlyBasis({ ...data, operation: "EARLY_CHECKIN", pricingBreakdown }), /NIGHTLY_PRICING_BASIS_REQUIRED/);
  }
});

const base = { currency: "usd", totalAmount: 150, totalAmountCents: 15000,
  nightlyRates: [{ date: "2026-10-01", rate: 100 }], nightlySubtotal: 100,
  cleaningFee: 30, amenities: [{ id: "breakfast", amount: 10 }], amenitiesTotal: 10,
  taxes: [{ id: "old-tax", amount: 10 }], taxesTotal: 10 };
const input = { currency: "usd", currentTotal: "150.00", pricingBreakdown: base,
  feeSubtotalMinor: 1502, platformFeePercent: "1.50",
  taxes: [{ id: "tax", name: "Configured property tax", percentage: "9.00", updatedAt: "2026-10-01T00:00:00Z" }] };

test("charges only time fee plus configured taxes and preserves original pricing verbatim", () => {
  const before = structuredClone(base);
  const quote = priceStayTimeService(input);
  assert.equal(quote.taxTotalMinor, 135);
  assert.equal(quote.additionalChargeMinor, 1637);
  assert.equal(quote.proposedTotalMinor, 16637);
  assert.equal(quote.additionalPlatformFeeMinor, 25);
  assert.equal(quote.additionalHostPayoutMinor, 1612);
  assert.equal(quote.additionalIdentityFeeMinor, 0);
  assert.deepEqual(quote.basePricingSnapshot, before);
  assert.deepEqual(base, before);
  assert.notEqual(quote.basePricingSnapshot, base);
});
test("free service adds no tax, host payout or platform/identity charge", () => {
  const quote = priceStayTimeService({ ...input, feeSubtotalMinor: 0 });
  assert.equal(quote.additionalChargeMinor, 0);
  assert.equal(quote.proposedTotalMinor, 15000);
  assert.equal(quote.additionalHostPayoutMinor, 0);
  assert.equal(quote.additionalPlatformFeeMinor, 0);
  assert.equal(quote.financialAction, "NO_PAYMENT_REQUIRED");
});
test("taxes round independently half-up and order is stable", () => {
  const taxes = ["b", "a"].map(id => ({ ...input.taxes[0]!, id, percentage: "10.00" }));
  const quote = priceStayTimeService({ ...input, feeSubtotalMinor: 5, taxes, platformFeePercent: "0" });
  assert.equal(quote.taxTotalMinor, 2);
  assert.equal(quote.additionalChargeMinor, 7);
  assert.deepEqual(quote.taxes.map(t => t.id), ["a", "b"]);
  assert.deepEqual(quote, priceStayTimeService({ ...input, feeSubtotalMinor: 5, taxes: taxes.reverse(), platformFeePercent: "0" }));
});
test("invalid money, policy, currency and base totals never silently become free", () => {
  for (const patch of [
    { currency: "EUR" }, { currentTotal: "151" }, { currentTotal: "150.001" },
    { feeSubtotalMinor: -1 }, { feeSubtotalMinor: 1.1 }, { platformFeePercent: "NaN" },
    { platformFeePercent: "101" }, { pricingBreakdown: null },
    { pricingBreakdown: { ...base, totalAmountCents: 1 } },
    { taxes: [...input.taxes, ...input.taxes] },
    { taxes: [{ ...input.taxes[0]!, percentage: "-1" }] },
    { taxes: [{ ...input.taxes[0]!, percentage: "101" }] },
    { currentTotal: "9007199254740991" },
  ]) assert.throws(() => priceStayTimeService({ ...input, ...patch }));
});
