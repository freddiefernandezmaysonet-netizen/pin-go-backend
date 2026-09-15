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
