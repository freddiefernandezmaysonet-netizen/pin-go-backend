import assert from "node:assert/strict";
import test from "node:test";

import {
  GATEWAY_FIRST_RETRY_MS,
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

test("gateway failure nextCheckAt remains authoritative before retry", () => {
  assert.equal(
    isGatewayCheckDue({
      now: NOW,
      mode: "ENABLED",
      health: health({
        gatewayConnected: false,
        gatewayNextCheckAt: new Date("2026-09-15T10:00:00.000Z"),
      }),
      checkIn: new Date("2026-09-15T05:00:00.000Z"),
    }),
    false
  );
});

test("healthy enabled gateway stays idle with no reservation inside 24 hours", () => {
  assert.equal(
    isGatewayCheckDue({
      now: NOW,
      mode: "ENABLED",
      health: health({
        gatewayLastCheckedAt: new Date("2026-09-01T02:00:00.000Z"),
        gatewayNextCheckAt: null,
      }),
      checkIn: null,
    }),
    false
  );
});

test("legacy unconfigured lock keeps no-reservation gateway behavior", () => {
  assert.equal(
    isGatewayCheckDue({
      now: NOW,
      mode: "LEGACY_UNCONFIGURED",
      health: health(),
      checkIn: null,
    }),
    false
  );
});

test("gateway success schedules no idle maintenance check without reservation", () => {
  assert.equal(
    nextGatewaySuccessCheckAt({
      now: NOW,
      mode: "ENABLED",
      checkIn: null,
    }),
    null
  );
});

test("gateway failure escalates on the third scheduled check", () => {
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

test("reservation inside 24 hours resumes gateway readiness checks", () => {
  assert.equal(
    isGatewayCheckDue({
      now: NOW,
      mode: "ENABLED",
      health: health({
        gatewayLastCheckedAt: new Date("2026-09-14T20:00:00.000Z"),
        gatewayNextCheckAt: null,
      }),
      checkIn: new Date("2026-09-15T22:00:00.000Z"),
    }),
    true
  );
});

test("reservation proximity accelerates gateway checks to one hour inside six hours", () => {
  const next = nextGatewaySuccessCheckAt({
    now: NOW,
    mode: "ENABLED",
    checkIn: new Date("2026-09-15T07:00:00.000Z"),
  });

  assert.equal(
    next?.toISOString(),
    "2026-09-15T03:00:00.000Z"
  );
});
