import assert from "node:assert/strict";
import test from "node:test";

import {
  effectiveGatewayHealth,
  shouldShowHealthLock,
} from "./dashboard.health.routes";

test("canonical gateway state overrides contradictory legacy per-lock state", () => {
  assert.deepEqual(
    effectiveGatewayHealth({
      canonicalOnline: false,
      legacyConnected: true,
      gatewayId: 2046625,
      lastEventAt: new Date("2026-09-27T18:00:00.000Z"),
    }),
    {
      gatewayConnected: false,
      gatewayId: 2046625,
      gatewayStateSource: "TTLOCK_GATEWAY",
      gatewayLastEventAt: new Date("2026-09-27T18:00:00.000Z"),
    }
  );

  assert.deepEqual(
    effectiveGatewayHealth({
      canonicalOnline: true,
      legacyConnected: false,
      gatewayId: 2046625,
    }),
    {
      gatewayConnected: true,
      gatewayId: 2046625,
      gatewayStateSource: "TTLOCK_GATEWAY",
      gatewayLastEventAt: null,
    }
  );
});

test("uninitialized canonical gateway falls back to legacy during cutover", () => {
  assert.deepEqual(
    effectiveGatewayHealth({
      canonicalOnline: null,
      legacyConnected: true,
      gatewayId: 2046625,
    }),
    {
      gatewayConnected: true,
      gatewayId: 2046625,
      gatewayStateSource: "LEGACY_DEVICE_HEALTH",
      gatewayLastEventAt: null,
    }
  );
});

test("offline shared gateway remains visible even with healthy operational risk", () => {
  assert.equal(
    shouldShowHealthLock({
      mode: "ENABLED",
      gatewayConnected: false,
      operationalRisk: "HEALTHY",
    }),
    true
  );

  assert.equal(
    shouldShowHealthLock({
      mode: "ENABLED",
      gatewayConnected: true,
      operationalRisk: "HEALTHY",
    }),
    false
  );

  assert.equal(
    shouldShowHealthLock({
      mode: "DISABLED",
      gatewayConnected: false,
      operationalRisk: "CRITICAL",
    }),
    false
  );
});
