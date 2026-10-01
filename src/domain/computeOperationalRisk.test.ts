import assert from "node:assert/strict";
import test from "node:test";

import { computeOperationalRisk } from "./computeOperationalRisk";

function inHours(hours: number) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

const HEALTHY_BASE = {
  healthStatus: "HEALTHY" as const,
  battery: 80,
  gatewayConnected: true,
  lastSeenAt: new Date(),
};

test("gateway offline more than six hours before arrival is warning, not critical", () => {
  const risk = computeOperationalRisk({
    ...HEALTHY_BASE,
    gatewayConnected: false,
    nextCheckInAt: inHours(7),
  });

  assert.equal(risk.operationalRisk, "WARNING");
});

test("gateway offline inside six-hour readiness window is critical", () => {
  const risk = computeOperationalRisk({
    ...HEALTHY_BASE,
    gatewayConnected: false,
    nextCheckInAt: inHours(5.5),
  });

  assert.equal(risk.operationalRisk, "CRITICAL");
});

test("battery between 20 and 29 percent remains warning with upcoming arrival", () => {
  const risk = computeOperationalRisk({
    ...HEALTHY_BASE,
    battery: 25,
    nextCheckInAt: inHours(4),
  });

  assert.equal(risk.operationalRisk, "WARNING");
});

test("battery below 20 percent is critical with upcoming arrival", () => {
  const risk = computeOperationalRisk({
    ...HEALTHY_BASE,
    battery: 19,
    nextCheckInAt: inHours(4),
  });

  assert.equal(risk.operationalRisk, "CRITICAL");
});

test("missing and null battery preserve existing telemetry and gateway decisions", () => {
  const input = {
    healthStatus: "HEALTHY" as const,
    gatewayConnected: true,
    lastSeenAt: new Date(),
    nextCheckInAt: inHours(4),
  };
  const absent = computeOperationalRisk(input);
  assert.equal(absent.operationalRisk, "HEALTHY");
  assert.deepEqual(computeOperationalRisk({ ...input, battery: null }), absent);
  assert.equal(
    computeOperationalRisk({ ...input, gatewayConnected: false }).operationalRisk,
    "CRITICAL",
  );
  assert.equal(
    computeOperationalRisk({ ...input, lastSeenAt: null }).operationalRisk,
    "UNKNOWN",
  );
});

test("zero battery and exact battery thresholds retain their risk levels", () => {
  for (const [battery, expected] of [
    [0, "CRITICAL"],
    [19, "CRITICAL"],
    [20, "WARNING"],
    [29, "WARNING"],
    [30, "HEALTHY"],
  ] as const) {
    assert.equal(
      computeOperationalRisk({
        ...HEALTHY_BASE,
        battery,
        nextCheckInAt: inHours(4),
      }).operationalRisk,
      expected,
      `battery ${battery}%`,
    );
  }
});
