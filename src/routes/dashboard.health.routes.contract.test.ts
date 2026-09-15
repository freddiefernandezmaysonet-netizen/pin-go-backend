import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./dashboard.health.routes.ts", import.meta.url),
  "utf8"
);

test("Health Center loads per-lock gateway monitoring policy", () => {
  assert.match(source, /loadGatewayMonitoringPolicies/);
  assert.match(source, /gatewayMonitoringModeFromPolicy/);
});

test("Health Center excludes explicitly disabled gateway monitoring from attention queues", () => {
  assert.match(source, /mode === "DISABLED"/);
  assert.match(source, /gatewayMonitoringMode !== "DISABLED"/);
  assert.match(source, /notMonitored/);
});

test("Health Center surfaces legacy unconfigured locks as setup required", () => {
  assert.match(source, /LEGACY_UNCONFIGURED/);
  assert.match(source, /SETUP_REQUIRED/);
  assert.match(source, /setupRequired/);
});
