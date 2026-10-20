import assert from "node:assert/strict";
import test from "node:test";
import { addUtcDays } from "../pms/outbound/channex-ari-lifecycle.policy.js";
import { buildRateRefreshPlan, readRateRefreshSnapshot, resolveRateRefreshConfig } from "./rate-refresh.policy.js";

const property = { id: "property-a", organizationId: "org-a", timezone: "America/Puerto_Rico",
  dynamicPricingEnabled: true, occupancyPricingEnabled: true, occupancyLookaheadDays: 30, leadTimePricingEnabled: true };
const now = new Date("2026-10-12T21:00:00Z");
const stay = (start: string, end: string) => ({ checkIn: new Date(start), checkOut: new Date(end) });
const base = { property, rateConfiguration: { base: "100.00", occupancyPricingEnabled: true }, reservations: [], previous: null, now };

test("bootstrap repairs the complete 500-day horizon without calculating or sending a price", () => {
  const p = buildRateRefreshPlan(base);
  assert.equal(p.changed, true);
  assert.deepEqual(p.rateFields, ["rate", "minStayArrival", "minStayThrough", "maxStay"]);
  assert.deepEqual(p.availabilityRange, { dateFrom: "2026-10-12", dateToExclusive: addUtcDays("2026-10-12", 500) });
  assert.deepEqual(readRateRefreshSnapshot(p.sourceEntityId), p.snapshot);
});
test("unchanged reservations/configuration do not generate repeated exports", () => {
  const first = buildRateRefreshPlan(base);
  assert.equal(buildRateRefreshPlan({ ...base, previous: first.snapshot,
    now: new Date("2026-10-12T21:10:00Z") }).changed, false);
});
test("new occupancy, cancellation and reactivation each trigger rates only", () => {
  const first = buildRateRefreshPlan(base);
  const booked = buildRateRefreshPlan({ ...base, previous: first.snapshot,
    reservations: [stay("2026-10-13T20:00Z", "2026-10-15T15:00Z")] });
  assert.equal(booked.snapshot.occupiedNights, 2);
  assert.equal(booked.changed, true);
  assert.deepEqual(booked.rateFields, ["rate"]);
  assert.equal(booked.availabilityRange, null);
  const cancelled = buildRateRefreshPlan({ ...base, previous: booked.snapshot });
  assert.equal(cancelled.changed, true);
  const reactivated = buildRateRefreshPlan({ ...base, previous: cancelled.snapshot,
    reservations: [stay("2026-10-13T20:00Z", "2026-10-15T15:00Z")] });
  assert.equal(reactivated.changed, true);
});
test("overlapping reservations count occupied nights once; irrelevant future/past bookings do not refresh", () => {
  const p = buildRateRefreshPlan({ ...base, reservations: [
    stay("2026-10-13T20:00Z", "2026-10-15T15:00Z"),
    stay("2026-10-14T20:00Z", "2026-10-16T15:00Z"),
  ] });
  assert.equal(p.snapshot.occupiedNights, 3);
  const initial = buildRateRefreshPlan(base);
  assert.equal(buildRateRefreshPlan({ ...base, previous: initial.snapshot, reservations: [
    stay("2026-12-01T20:00Z", "2026-12-02T15:00Z"),
    stay("2026-10-01T20:00Z", "2026-10-02T15:00Z"),
  ] }).changed, false);
});
test("UTC midnight refreshes time-sensitive Revenue prices before Puerto Rico midnight", () => {
  const first = buildRateRefreshPlan({ ...base, now: new Date("2026-10-12T23:59:00Z") });
  const next = buildRateRefreshPlan({ ...base, previous: first.snapshot, now: new Date("2026-10-13T00:01:00Z") });
  assert.equal(next.snapshot.localDay, "2026-10-12");
  assert.equal(next.changed, true);
  assert.deepEqual(next.rateFields, ["rate"]);
  assert.equal(next.availabilityRange, null);
});
test("local midnight replenishes the newly exposed night and its restrictions", () => {
  const first = buildRateRefreshPlan({ ...base, now: new Date("2026-10-13T03:59:00Z") });
  const next = buildRateRefreshPlan({ ...base, previous: first.snapshot, now: new Date("2026-10-13T04:01:00Z") });
  assert.deepEqual(next.availabilityRange, {
    dateFrom: addUtcDays("2026-10-12", 500), dateToExclusive: addUtcDays("2026-10-13", 500),
  });
  assert.deepEqual(next.rateFields, ["rate", "minStayArrival", "minStayThrough", "maxStay"]);
});
test("downtime catches up every missing horizon night, including leap day", () => {
  const first = buildRateRefreshPlan({ ...base, now: new Date("2028-02-27T20:00Z") });
  const next = buildRateRefreshPlan({ ...base, previous: first.snapshot, now: new Date("2028-03-02T20:00Z") });
  assert.deepEqual(next.availabilityRange, {
    dateFrom: addUtcDays("2028-02-27", 500), dateToExclusive: addUtcDays("2028-03-02", 500),
  });
});
test("static properties avoid UTC-only refreshes but still renew their local horizon", () => {
  const plain = { ...property, dynamicPricingEnabled: false };
  const first = buildRateRefreshPlan({ ...base, property: plain, now: new Date("2026-10-12T23:59Z") });
  assert.equal(buildRateRefreshPlan({ ...base, property: plain, previous: first.snapshot,
    now: new Date("2026-10-13T00:01Z") }).changed, false);
});
test("configuration changes refresh prices; object ordering does not", () => {
  const first = buildRateRefreshPlan(base);
  assert.equal(buildRateRefreshPlan({ ...base, previous: first.snapshot,
    rateConfiguration: { occupancyPricingEnabled: true, base: "100.00" } }).changed, false);
  assert.equal(buildRateRefreshPlan({ ...base, previous: first.snapshot,
    rateConfiguration: { base: "110.00", occupancyPricingEnabled: true } }).changed, true);
});
test("bad ledger/timezone fails closed and worker defaults off", () => {
  assert.throws(() => readRateRefreshSnapshot("{}"), /LEDGER_INVALID/);
  assert.throws(() => buildRateRefreshPlan({ ...base, property: { ...property, timezone: "invalid" } }));
  assert.equal(resolveRateRefreshConfig({}).enabled, false);
  assert.deepEqual(resolveRateRefreshConfig({ DISTRIBUTION_RATE_REFRESH_ENABLED: "true" }), { enabled: true, pollMs: 60000 });
  assert.throws(() => resolveRateRefreshConfig({ DISTRIBUTION_RATE_REFRESH_ENABLED: "yes" }));
  assert.throws(() => resolveRateRefreshConfig({ DISTRIBUTION_RATE_REFRESH_POLL_MS: "1" }));
});
