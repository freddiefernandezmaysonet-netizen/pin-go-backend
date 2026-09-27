import assert from "node:assert/strict";
import test from "node:test";

import { shouldShowHealthLock } from "./dashboard.health.routes";
import { effectiveTtlockGatewayHealth } from "../services/ttlock-gateway-read-model";

test("canonical gateway state overrides contradictory legacy per-lock state", () => {
  assert.deepEqual(
    effectiveTtlockGatewayHealth({
      canonicalOnline: false,
      legacyConnected: true,
      gatewayId: 2046625,
      lastEventAt: new Date("2026-09-27T18:00:00.000Z"),
    }),
    {
      gatewayConnected: false,
      gatewayId: 2046625,
      gatewayName: null,
      gatewayStateSource: "TTLOCK_GATEWAY",
      gatewayLastEventAt: new Date("2026-09-27T18:00:00.000Z"),
    }
  );

  assert.deepEqual(
    effectiveTtlockGatewayHealth({
      canonicalOnline: true,
      legacyConnected: false,
      gatewayId: 2046625,
    }),
    {
      gatewayConnected: true,
      gatewayId: 2046625,
      gatewayName: null,
      gatewayStateSource: "TTLOCK_GATEWAY",
      gatewayLastEventAt: null,
    }
  );
});

test("uninitialized canonical gateway remains unknown and never falls back to legacy state", () => {
  assert.deepEqual(
    effectiveTtlockGatewayHealth({
      canonicalOnline: null,
      legacyConnected: true,
      gatewayId: 2046625,
    }),
    {
      gatewayConnected: null,
      gatewayId: 2046625,
      gatewayName: null,
      gatewayStateSource: "TTLOCK_GATEWAY_UNKNOWN",
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
