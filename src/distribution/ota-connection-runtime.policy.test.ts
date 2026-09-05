import assert from "node:assert/strict";
import test from "node:test";

import { resolveOtaConnectionCenterRuntime } from "./ota-connection-runtime.policy.js";

test("connection center mutations are default-off", () => {
  assert.deepEqual(resolveOtaConnectionCenterRuntime(undefined), {
    enabled: false,
    reason: "DEFAULT_OFF",
  });
  assert.equal(resolveOtaConnectionCenterRuntime("").enabled, false);
  assert.equal(resolveOtaConnectionCenterRuntime("false").enabled, false);
  assert.equal(resolveOtaConnectionCenterRuntime("0").enabled, false);
});

test("only explicit supported values enable the runtime", () => {
  assert.equal(resolveOtaConnectionCenterRuntime("true").enabled, true);
  assert.equal(resolveOtaConnectionCenterRuntime("1").enabled, true);
  assert.deepEqual(resolveOtaConnectionCenterRuntime("yes"), {
    enabled: false,
    reason: "INVALID_CONFIGURATION",
  });
});
