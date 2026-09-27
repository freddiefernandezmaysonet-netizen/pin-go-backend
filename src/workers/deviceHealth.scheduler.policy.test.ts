import assert from "node:assert/strict";
import test from "node:test";

import {
  GATEWAY_FIRST_RETRY_MS,
  GATEWAY_READINESS_WINDOW_MS,
  GATEWAY_SECOND_RETRY_MS,
  isBatteryCheckDue,
  isGatewayCheckDue,
  nextGatewayFailure,
  nextGatewaySuccessCheckAt,
} from "./deviceHealth.scheduler.policy";

const NOW = new Date("2026-09-15T02:00:00.000Z");

function health(overrides: Partial<{
  battery: number | null;
  batteryLastCheckedAt: Date | null;
  batteryNextCheckAt: Date | null;
  gatewayConnected: boolean | null;
  gatewayLastCheckedAt: Date | null;
  gatewayLastSuccessfulAt: Date | null;
  gatewayNextCheckAt: Date | null;
  gatewayDisconnectedSince: Date | null;
}> = {}) {
  return {
    battery: 80,
    batteryLastCheckedAt: new Date("2026-09-14T02:00:00.000Z"),
    batteryNextCheckAt: new Date("2026-10-14T02:00:00.000Z"),
    gatewayConnected: true,
    gatewayLastCheckedAt: new Date("2026-09-14T02:00:00.000Z"),
    gatewayLastSuccessfulAt: new Date("2026-09-14T02:00:00.000Z"),
    gatewayNextCheckAt: null,
    gatewayDisconnectedSince: null,
    ...overrides,
  };
}

test("battery nextCheckAt is authoritative even when battery is null", () => {
  assert.equal(
    isBatteryCheckDue({
      now: NOW,
      health: health({
        battery: null,
        batteryNextCheckAt: new Date("2026-09-16T02:00:00.000Z"),
      }),
    }),
    false
  );
});

test("battery becomes due when nextCheckAt passes", () => {
  assert.equal(
    isBatteryCheckDue({
      now: NOW,
      health: health({
        battery: null,
        batteryNextCheckAt: new Date("2026-09-15T01:59:59.000Z"),
      }),
    }),
    true
  );
});

test("gateway monitoring disabled means zero gateway polling", () => {
  assert.equal(
    isGatewayCheckDue({
      now: NOW,
      mode: "DISABLED",
      health: null,
      checkIn: new Date("2026-09-15T05:00:00.000Z"),
    }),
    false
  );
});

test("gateway remains quiet when there is no upcoming reservation", () => {
  assert.equal(
    isGatewayCheckDue({
      now: NOW,
      mode: "ENABLED",
      health: health({
        gatewayConnected: false,
        gatewayNextCheckAt: new Date("2026-09-15T01:00:00.000Z"),
      }),
      checkIn: null,
    }),
    false
  );
});

test("gateway remains quiet before the six-hour readiness window", () => {
  assert.equal(
    isGatewayCheckDue({
      now: NOW,
      mode: "ENABLED",
      health: health({
        gatewayLastCheckedAt: new Date("2026-09-14T20:00:00.000Z"),
      }),
      checkIn: new Date("2026-09-15T09:00:00.000Z"),
    }),
    false
  );
});

test("gateway becomes due when reservation enters the six-hour readiness window", () => {
  const checkIn = new Date(
    NOW.getTime() + GATEWAY_READINESS_WINDOW_MS
  );

  assert.equal(
    isGatewayCheckDue({
      now: NOW,
      mode: "ENABLED",
      health: health({
        gatewayLastCheckedAt: new Date("2026-09-14T20:00:00.000Z"),
        gatewayLastSuccessfulAt: new Date("2026-09-14T20:00:00.000Z"),
      }),
      checkIn,
    }),
    true
  );
});

test("healthy gateway certified inside T-6 is not checked again for that arrival", () => {
  const checkIn = new Date("2026-09-15T07:00:00.000Z");
  const certifiedAt = new Date("2026-09-15T02:00:00.000Z");

  assert.equal(
    isGatewayCheckDue({
      now: new Date("2026-09-15T05:00:00.000Z"),
      mode: "ENABLED",
      health: health({
        gatewayConnected: true,
        gatewayLastCheckedAt: certifiedAt,
        gatewayLastSuccessfulAt: certifiedAt,
        gatewayNextCheckAt: null,
      }),
      checkIn,
    }),
    false
  );
});

test("failed T-6 gateway check respects its hourly recovery timer", () => {
  const now = new Date("2026-09-15T03:00:00.000Z");
  const checkIn = new Date("2026-09-15T07:00:00.000Z");

  assert.equal(
    isGatewayCheckDue({
      now,
      mode: "ENABLED",
      health: health({
        gatewayConnected: false,
        gatewayLastCheckedAt: new Date("2026-09-15T02:00:00.000Z"),
        gatewayLastSuccessfulAt: null,
        gatewayNextCheckAt: new Date("2026-09-15T04:00:00.000Z"),
      }),
      checkIn,
    }),
    false
  );

  assert.equal(
    isGatewayCheckDue({
      now: new Date("2026-09-15T04:00:00.000Z"),
      mode: "ENABLED",
      health: health({
        gatewayConnected: false,
        gatewayLastCheckedAt: new Date("2026-09-15T02:00:00.000Z"),
        gatewayLastSuccessfulAt: null,
        gatewayNextCheckAt: new Date("2026-09-15T04:00:00.000Z"),
      }),
      checkIn,
    }),
    true
  );
});

test("successful gateway readiness check schedules no further check", () => {
  assert.equal(
    nextGatewaySuccessCheckAt({
      now: NOW,
      mode: "ENABLED",
      checkIn: new Date("2026-09-15T07:00:00.000Z"),
    }),
    null
  );
});

test("gateway failure outside reservations still retains maintenance escalation planner", () => {
  const first = nextGatewayFailure({
    now: NOW,
    disconnectedSince: null,
  });

  assert.equal(first.escalate, false);
  assert.equal(
    first.nextCheckAt.getTime() - NOW.getTime(),
    GATEWAY_FIRST_RETRY_MS
  );

  const secondNow = first.nextCheckAt;
  const second = nextGatewayFailure({
    now: secondNow,
    disconnectedSince: NOW,
  });

  assert.equal(second.escalate, false);
  assert.equal(
    second.nextCheckAt.getTime() - secondNow.getTime(),
    GATEWAY_SECOND_RETRY_MS
  );

  const third = nextGatewayFailure({
    now: second.nextCheckAt,
    disconnectedSince: NOW,
  });

  assert.equal(third.escalate, true);
  assert.equal(third.stage, "ACTION_REQUIRED");
});

test("gateway failure inside T-6 retries hourly", () => {
  const plan = nextGatewayFailure({
    now: NOW,
    disconnectedSince: null,
    checkIn: new Date("2026-09-15T07:00:00.000Z"),
  });

  assert.equal(plan.escalate, false);
  assert.equal(plan.stage, "RESERVATION_RETRY");
  assert.equal(
    plan.nextCheckAt.toISOString(),
    "2026-09-15T03:00:00.000Z"
  );
});
