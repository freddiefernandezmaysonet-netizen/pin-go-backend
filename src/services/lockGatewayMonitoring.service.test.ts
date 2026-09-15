import assert from "node:assert/strict";
import test from "node:test";

import {
  gatewayMonitoringEnabledForWorker,
  shouldSurfaceDeviceHealthAlert,
} from "./lockGatewayMonitoring.service";

test("gateway-disabled locks do not participate in remote monitoring", () => {
  assert.equal(gatewayMonitoringEnabledForWorker("DISABLED"), false);
  assert.equal(shouldSurfaceDeviceHealthAlert("DISABLED"), false);
});

test("gateway-enabled locks participate in monitoring and alerts", () => {
  assert.equal(gatewayMonitoringEnabledForWorker("ENABLED"), true);
  assert.equal(shouldSurfaceDeviceHealthAlert("ENABLED"), true);
});

test("legacy unconfigured locks preserve compatibility until classified", () => {
  assert.equal(gatewayMonitoringEnabledForWorker("LEGACY_UNCONFIGURED"), true);
  assert.equal(shouldSurfaceDeviceHealthAlert("LEGACY_UNCONFIGURED"), true);
});
