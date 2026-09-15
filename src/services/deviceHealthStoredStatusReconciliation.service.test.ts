import assert from "node:assert/strict";
import test from "node:test";

import { reconcileStoredDeviceHealthStatus } from "./deviceHealthStoredStatusReconciliation.service";

const HEALTHY_BASE = {
  healthStatus: "HEALTHY" as const,
  healthMessage: "Device operating normally",
  gatewayConnected: true,
  isOnline: true,
};

test("healthy with disconnected gateway becomes warning", () => {
  const result = reconcileStoredDeviceHealthStatus({
    ...HEALTHY_BASE,
    gatewayConnected: false,
  });

  assert.deepEqual(result, {
    healthStatus: "WARNING",
    healthMessage: "Gateway disconnected",
    changed: true,
  });
});

test("healthy with explicit offline state becomes offline", () => {
  const result = reconcileStoredDeviceHealthStatus({
    ...HEALTHY_BASE,
    gatewayConnected: false,
    isOnline: false,
  });

  assert.deepEqual(result, {
    healthStatus: "OFFLINE",
    healthMessage: "No recent activity",
    changed: true,
  });
});

test("healthy connected lock remains unchanged", () => {
  const result = reconcileStoredDeviceHealthStatus(HEALTHY_BASE);

  assert.deepEqual(result, {
    healthStatus: "HEALTHY",
    healthMessage: "Device operating normally",
    changed: false,
  });
});

test("non-healthy status is never overwritten by consistency reconciliation", () => {
  const result = reconcileStoredDeviceHealthStatus({
    healthStatus: "LOW_BATTERY",
    healthMessage: "Battery below threshold",
    gatewayConnected: false,
    isOnline: false,
  });

  assert.deepEqual(result, {
    healthStatus: "LOW_BATTERY",
    healthMessage: "Battery below threshold",
    changed: false,
  });
});
