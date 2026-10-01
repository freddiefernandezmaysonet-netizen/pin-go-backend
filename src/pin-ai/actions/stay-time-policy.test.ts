import assert from "node:assert/strict";
import test from "node:test";
import { calculateStayTimeFee, planStayTimeAdjustment, StayTimePolicyError } from "./stay-time-policy.js";
import type { StayTimeFee, StayTimeOperation } from "./stay-time-policy.js";

type Input = Parameters<typeof planStayTimeAdjustment>[0];
const date = (value: string) => new Date(value);
function fixture(operation: StayTimeOperation = "LATE_CHECKOUT"): Input {
  const now = date("2026-10-01T12:00:00Z");
  const checkIn = date("2026-10-01T19:00:00Z");
  const scope = { organizationId: "org-1", propertyId: "property-1" };
  return {
    operation, now,
    requestedAt: date(operation === "EARLY_CHECKIN" ? "2026-10-01T17:00:00Z" : "2026-10-02T17:00:00Z"),
    reservation: {
      ...scope, id: "stay-1", status: "ACTIVE", paymentState: "PAID", source: "DIRECT_BOOKING",
      externalProvider: null, currency: "USD", checkIn, checkOut: date("2026-10-02T15:00:00Z"),
      adjustedOperations: [],
    },
    policy: {
      ...scope, version: "policy-v1", timezone: "America/Puerto_Rico",
      earlyCheckin: { enabled: true, limitLocalTime: "12:00", fee: { mode: "FREE", amountMinor: 0, currency: "USD" } },
      lateCheckout: { enabled: true, limitLocalTime: "14:00", fee: { mode: "PER_HOUR", amountMinor: 2500, currency: "USD" } },
      cleaningStartOffsetMinutes: 30, cleaningDurationMinutes: 180,
    },
    evidence: {
      ...scope, reservationId: "stay-1", checkedAt: now,
      coveredFrom: date("2026-10-01T00:00:00Z"), coveredUntil: date("2026-10-03T00:00:00Z"), conflicts: [],
      arrivalReadiness: { arrivingReservationId: "stay-1", scheduledCheckIn: checkIn,
        status: "READY", evidenceId: "canonical-readiness-1", assessedAt: now },
    },
  };
}
function rejects(input: Input, code: string) {
  assert.throws(() => planStayTimeAdjustment(input), (error: unknown) =>
    error instanceof StayTimePolicyError && error.code === code);
}

test("late checkout preserves arrival and includes offset plus cleaning duration", () => {
  const input = fixture();
  const before = JSON.stringify(input);
  const result = planStayTimeAdjustment(input);
  assert.equal(result.checkIn, input.reservation.checkIn.toISOString());
  assert.equal(result.checkOut, "2026-10-02T17:00:00.000Z");
  assert.equal(result.requiredFreeUntil, "2026-10-02T20:30:00.000Z");
  assert.equal(result.additionalMinutes, 120);
  assert.equal(result.feeSubtotalMinor, 5000);
  assert.equal(result.policyVersion, "policy-v1");
  assert.equal(result.paymentReady, false);
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.actionExecuted, false);
  assert.equal(result.requiresGuestConfirmation, true);
  assert.ok(Object.isFrozen(result));
  assert.equal(JSON.stringify(input), before);
});

test("early arrival preserves departure and uses its independent free rule", () => {
  const input = fixture("EARLY_CHECKIN");
  const result = planStayTimeAdjustment(input);
  assert.equal(result.checkIn, "2026-10-01T17:00:00.000Z");
  assert.equal(result.checkOut, input.reservation.checkOut.toISOString());
  assert.equal(result.feeSubtotalMinor, 0);
  assert.equal(result.additionalMinutes, 120);
});

test("fixed fee is charged once; hourly fee prorates minutes and rounds half up", () => {
  const fixed: StayTimeFee = { mode: "FIXED", amountMinor: 3000, currency: "USD" };
  assert.equal(calculateStayTimeFee(fixed, 15), 3000);
  assert.equal(calculateStayTimeFee(fixed, 180), 3000);
  const hourly: StayTimeFee = { mode: "PER_HOUR", amountMinor: 2500, currency: "USD" };
  assert.equal(calculateStayTimeFee(hourly, 90), 3750);
  assert.equal(calculateStayTimeFee(hourly, 1), 42);
  assert.equal(calculateStayTimeFee({ ...hourly, amountMinor: 1 }, 30), 1);
});

for (const fee of [
  { mode: "FREE", amountMinor: 1 }, { mode: "FIXED", amountMinor: 0 },
  { mode: "PER_HOUR", amountMinor: -1 }, { mode: "FIXED", amountMinor: 1.5 },
  { mode: "FIXED", amountMinor: NaN }, { mode: "FREE", amountMinor: Infinity },
]) {
  test(`rejects invalid fee ${JSON.stringify(fee)}`, () => {
    assert.throws(() => calculateStayTimeFee({ ...fee, currency: "USD" } as StayTimeFee, 60),
      (error: unknown) => error instanceof StayTimePolicyError && error.code === "INVALID_FEE_POLICY");
  });
}

test("overflow, sub-minor-unit prices and invalid duration fail closed", () => {
  const fee: StayTimeFee = { mode: "PER_HOUR", amountMinor: Number.MAX_SAFE_INTEGER, currency: "USD" };
  assert.throws(() => calculateStayTimeFee(fee, 120), /FEE_OVERFLOW/);
  assert.throws(() => calculateStayTimeFee({ ...fee, amountMinor: 1 }, 1), /FEE_BELOW_MINOR_UNIT/);
  for (const minutes of [0, -1, 1.5, NaN, Infinity, 1501]) {
    assert.throws(() => calculateStayTimeFee(fee, minutes), /INVALID_ADDITIONAL_MINUTES/);
  }
});

for (const operation of ["EARLY_CHECKIN", "LATE_CHECKOUT"] as const) {
  test(`${operation} rejects disabled service and wrong direction`, () => {
    const input = fixture(operation);
    const key = operation === "EARLY_CHECKIN" ? "earlyCheckin" : "lateCheckout";
    rejects({ ...input, policy: { ...input.policy, [key]: { ...input.policy[key], enabled: false } } }, "SERVICE_DISABLED");
    rejects({ ...input, requestedAt: operation === "EARLY_CHECKIN" ? input.reservation.checkIn : input.reservation.checkOut }, "INVALID_TIME_DIRECTION");
  });
  test(`${operation} respects local day and host boundary`, () => {
    const input = fixture(operation);
    const boundary = date(operation === "EARLY_CHECKIN" ? "2026-10-01T16:00:00Z" : "2026-10-02T18:00:00Z");
    assert.doesNotThrow(() => planStayTimeAdjustment({ ...input, requestedAt: boundary }));
    rejects({ ...input, requestedAt: new Date(boundary.getTime() + (operation === "EARLY_CHECKIN" ? -60_000 : 60_000)) }, "HOST_TIME_LIMIT_EXCEEDED");
    rejects({ ...input, requestedAt: date(operation === "EARLY_CHECKIN" ? "2026-10-01T03:00:00Z" : "2026-10-03T04:00:00Z"),
      now: date("2026-09-30T12:00:00Z"), evidence: { ...input.evidence, checkedAt: date("2026-09-30T12:00:00Z") } }, "SAME_LOCAL_DAY_REQUIRED");
  });
  test(`${operation} requires an open request window and minute precision`, () => {
    const input = fixture(operation);
    const now = operation === "EARLY_CHECKIN" ? input.requestedAt : input.reservation.checkOut;
    rejects({ ...input, now, evidence: { ...input.evidence, checkedAt: now } }, "REQUEST_WINDOW_CLOSED");
    rejects({ ...input, requestedAt: new Date(input.requestedAt.getTime() + 1_000) }, "MINUTE_PRECISION_REQUIRED");
  });
  test(`${operation} requires active paid direct booking and no previous same adjustment`, () => {
    const input = fixture(operation);
    for (const patch of [{ status: "CANCELLED" }, { paymentState: "UNPAID" }, { paymentState: "PARTIALLY_REFUNDED" }]) {
      rejects({ ...input, reservation: { ...input.reservation, ...patch } }, "INELIGIBLE_RESERVATION");
    }
    rejects({ ...input, reservation: { ...input.reservation, source: "CHANNEX", externalProvider: "CHANNEX" } }, "DIRECT_BOOKING_REQUIRED");
    rejects({ ...input, reservation: { ...input.reservation, adjustedOperations: [operation] } }, "REPEATED_ADJUSTMENT_REQUIRES_REVIEW");
  });
}

test("turnover rejects next arrival inside offset even when duration alone fits", () => {
  const input = fixture();
  rejects({ ...input, evidence: { ...input.evidence, conflicts: [
    { startsAt: date("2026-10-02T20:00:00Z"), endsAt: date("2026-10-03T15:00:00Z") },
  ] } }, "TURNOVER_CONFLICT");
  assert.doesNotThrow(() => planStayTimeAdjustment({ ...input, evidence: { ...input.evidence, conflicts: [
    { startsAt: date("2026-10-02T20:30:00Z"), endsAt: date("2026-10-03T15:00:00Z") },
  ] } }));
});

test("early arrival rejects occupied extra interval, including holds or blocks", () => {
  const input = fixture("EARLY_CHECKIN");
  rejects({ ...input, evidence: { ...input.evidence, conflicts: [
    { startsAt: date("2026-09-30T19:00:00Z"), endsAt: date("2026-10-01T17:01:00Z") },
  ] } }, "TURNOVER_CONFLICT");
});

test("acceptance of a cleaning assignment cannot stand in for arrival readiness", () => {
  const input = fixture("EARLY_CHECKIN");
  rejects({ ...input, evidence: { ...input.evidence, arrivalReadiness: null } }, "ARRIVAL_READINESS_REQUIRED");
  const readiness = input.evidence.arrivalReadiness!;
  for (const patch of [
    { status: "NOT_READY" as const }, { status: "UNKNOWN" as const },
    { arrivingReservationId: "other-stay" }, { scheduledCheckIn: date("2026-10-02T19:00:00Z") },
    { evidenceId: "" }, { assessedAt: date("2026-10-01T11:58:59Z") },
    { assessedAt: date("2026-10-01T12:00:01Z") },
  ]) {
    rejects({ ...input, evidence: { ...input.evidence, arrivalReadiness: { ...readiness, ...patch } } }, "ARRIVAL_READINESS_REQUIRED");
  }
});

test("policy and operational evidence must share organization, property and reservation", () => {
  const input = fixture();
  for (const patch of [{ organizationId: "other-org" }, { propertyId: "other-property" }]) {
    rejects({ ...input, policy: { ...input.policy, ...patch } }, "SCOPE_MISMATCH");
    rejects({ ...input, evidence: { ...input.evidence, ...patch } }, "SCOPE_MISMATCH");
  }
  rejects({ ...input, evidence: { ...input.evidence, reservationId: "other-stay" } }, "SCOPE_MISMATCH");
});

test("availability coverage and freshness are required, including future-dated evidence", () => {
  const input = fixture();
  for (const checkedAt of [date("2026-10-01T11:58:59Z"), date("2026-10-01T12:00:01Z"), new Date(NaN)]) {
    rejects({ ...input, evidence: { ...input.evidence, checkedAt } }, "STALE_OPERATIONAL_EVIDENCE");
  }
  rejects({ ...input, evidence: { ...input.evidence, coveredUntil: date("2026-10-02T20:00:00Z") } }, "INCOMPLETE_AVAILABILITY_EVIDENCE");
  rejects({ ...input, evidence: { ...input.evidence, coveredFrom: date("2026-10-02T15:01:00Z") } }, "INCOMPLETE_AVAILABILITY_EVIDENCE");
  rejects({ ...input, evidence: { ...input.evidence, conflicts: [{ startsAt: input.now, endsAt: input.now }] } }, "INVALID_AVAILABILITY_EVIDENCE");
});

test("invalid configuration never defaults to an operational approval", () => {
  const input = fixture();
  rejects({ ...input, policy: { ...input.policy, timezone: "Invalid/Timezone" } }, "INVALID_TIMEZONE");
  rejects({ ...input, policy: { ...input.policy, lateCheckout: { ...input.policy.lateCheckout, limitLocalTime: "25:00" } } }, "INVALID_LOCAL_TIME");
  rejects({ ...input, reservation: { ...input.reservation, currency: "EUR" } }, "CURRENCY_MISMATCH");
  for (const patch of [{ cleaningStartOffsetMinutes: -1 }, { cleaningDurationMinutes: 0 }, { cleaningDurationMinutes: NaN }]) {
    rejects({ ...input, policy: { ...input.policy, ...patch } }, "INVALID_CLEANING_WINDOW");
  }
  rejects({ ...input, requestedAt: new Date(NaN) }, "INVALID_STAY_TIME");
});

test("local calendar day works across UTC midnight", () => {
  const input = fixture("EARLY_CHECKIN");
  const checkIn = date("2026-10-02T02:00:00Z"); // Oct 1, 22:00 in PR
  const result = planStayTimeAdjustment({ ...input, requestedAt: date("2026-10-02T00:00:00Z"),
    reservation: { ...input.reservation, checkIn },
    evidence: { ...input.evidence, arrivalReadiness: { ...input.evidence.arrivalReadiness!, scheduledCheckIn: checkIn } } });
  assert.equal(result.additionalMinutes, 120);
});

test("hourly fee uses real elapsed minutes across DST fall-back", () => {
  const input = fixture();
  const now = date("2026-11-01T04:00:00Z");
  const result = planStayTimeAdjustment({ ...input, now, requestedAt: date("2026-11-01T07:00:00Z"),
    reservation: { ...input.reservation, checkIn: date("2026-10-31T19:00:00Z"), checkOut: date("2026-11-01T05:00:00Z") },
    policy: { ...input.policy, timezone: "America/New_York" },
    evidence: { ...input.evidence, checkedAt: now, coveredFrom: now, coveredUntil: date("2026-11-02T00:00:00Z") } });
  assert.equal(result.additionalMinutes, 120);
  assert.equal(result.feeSubtotalMinor, 5000);
});
