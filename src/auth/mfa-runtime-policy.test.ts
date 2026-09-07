import assert from "node:assert/strict";
import test from "node:test";
import { evaluateE3LoginRuntime, resolveE3MfaMode } from "./mfa-runtime-policy.js";

test("E3 defaults to OFF", () => {
  assert.deepEqual(resolveE3MfaMode(undefined), { mode: "OFF", enforceBlocked: false });
});

test("E3 accepts SHADOW", () => {
  assert.deepEqual(resolveE3MfaMode("shadow"), { mode: "SHADOW", enforceBlocked: false });
});

test("E3 blocks ENFORCE from becoming active", () => {
  assert.deepEqual(resolveE3MfaMode("ENFORCE"), { mode: "OFF", enforceBlocked: true });
});

test("unknown modes fail safely to OFF", () => {
  assert.deepEqual(resolveE3MfaMode("anything"), { mode: "OFF", enforceBlocked: false });
});

test("OFF never loads MFA persistence", async () => {
  let called = false;
  const result = await evaluateE3LoginRuntime({
    configuredMode: "OFF",
    loadVerifiedFactorCount: async () => { called = true; return 1; },
  });
  assert.equal(called, false);
  assert.deepEqual(result, { mode: "OFF", sessionAllowed: true, telemetry: "MFA_OFF", verifiedFactorCount: null });
});

test("SHADOW observes verified factors but always permits session", async () => {
  const result = await evaluateE3LoginRuntime({ configuredMode: "SHADOW", loadVerifiedFactorCount: async () => 2 });
  assert.deepEqual(result, { mode: "SHADOW", sessionAllowed: true, telemetry: "MFA_SHADOW_FACTOR_PRESENT", verifiedFactorCount: 2 });
});

test("SHADOW observes missing factors but always permits session", async () => {
  const result = await evaluateE3LoginRuntime({ configuredMode: "SHADOW", loadVerifiedFactorCount: async () => 0 });
  assert.deepEqual(result, { mode: "SHADOW", sessionAllowed: true, telemetry: "MFA_SHADOW_NO_FACTOR", verifiedFactorCount: 0 });
});

test("SHADOW persistence failure cannot block login", async () => {
  const result = await evaluateE3LoginRuntime({ configuredMode: "SHADOW", loadVerifiedFactorCount: async () => { throw new Error("db unavailable"); } });
  assert.deepEqual(result, { mode: "SHADOW", sessionAllowed: true, telemetry: "MFA_SHADOW_LOOKUP_FAILED", verifiedFactorCount: null });
});

test("ENFORCE never loads persistence and still permits legacy session in E3", async () => {
  let called = false;
  const result = await evaluateE3LoginRuntime({ configuredMode: "ENFORCE", loadVerifiedFactorCount: async () => { called = true; return 1; } });
  assert.equal(called, false);
  assert.deepEqual(result, { mode: "OFF", sessionAllowed: true, telemetry: "MFA_ENFORCE_BLOCKED", verifiedFactorCount: null });
});
