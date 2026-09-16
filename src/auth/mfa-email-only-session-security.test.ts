import assert from "node:assert/strict";
import test from "node:test";
import { assertAllowedPinGoMfaFactor, isAllowedPinGoMfaFactor, normalizeMfaEmail } from "./mfa-email-only-policy.js";
import {
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
  TRUSTED_DEVICE_TTL_MS,
  evaluateSessionSecurity,
  isTrustedDeviceValid,
  trustedDeviceExpiresAt,
} from "./session-security.policy.js";

test("Pin&Go MFA accepts EMAIL", () => {
  assert.equal(isAllowedPinGoMfaFactor("email"), true);
  assert.doesNotThrow(() => assertAllowedPinGoMfaFactor("EMAIL"));
});

test("Pin&Go MFA rejects SMS", () => {
  assert.equal(isAllowedPinGoMfaFactor("SMS"), false);
  assert.throws(() => assertAllowedPinGoMfaFactor("SMS"), /MFA_FACTOR_EMAIL_ONLY/);
});

test("MFA email is normalized", () => {
  assert.equal(normalizeMfaEmail(" Host@Example.COM "), "host@example.com");
});

test("session policy constants are 30m idle, 12h absolute, 30d trusted", () => {
  assert.equal(SESSION_IDLE_TIMEOUT_MS, 30 * 60 * 1000);
  assert.equal(SESSION_ABSOLUTE_TIMEOUT_MS, 12 * 60 * 60 * 1000);
  assert.equal(TRUSTED_DEVICE_TTL_MS, 30 * 24 * 60 * 60 * 1000);
});

test("active session remains valid", () => {
  const now = new Date("2026-09-16T12:00:00.000Z");
  assert.deepEqual(evaluateSessionSecurity({
    authenticatedAt: new Date(now.getTime() - 60 * 60 * 1000),
    lastActivityAt: new Date(now.getTime() - 10 * 60 * 1000),
  }, now), { valid: true, reason: "ACTIVE" });
});

test("30 minutes idle expires session", () => {
  const now = new Date("2026-09-16T12:00:00.000Z");
  assert.deepEqual(evaluateSessionSecurity({
    authenticatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
    lastActivityAt: new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS),
  }, now), { valid: false, reason: "IDLE_TIMEOUT" });
});

test("12 hours absolute expires session despite recent activity", () => {
  const now = new Date("2026-09-16T12:00:00.000Z");
  assert.deepEqual(evaluateSessionSecurity({
    authenticatedAt: new Date(now.getTime() - SESSION_ABSOLUTE_TIMEOUT_MS),
    lastActivityAt: new Date(now.getTime() - 60 * 1000),
  }, now), { valid: false, reason: "ABSOLUTE_TIMEOUT" });
});

test("trusted device expires exactly 30 days later", () => {
  const now = new Date("2026-09-16T12:00:00.000Z");
  assert.equal(trustedDeviceExpiresAt(now).getTime() - now.getTime(), TRUSTED_DEVICE_TTL_MS);
});

test("trusted device is invalid when revoked", () => {
  const now = new Date("2026-09-16T12:00:00.000Z");
  assert.equal(isTrustedDeviceValid(new Date(now.getTime() + 1000), new Date(now.getTime() - 1000), now), false);
});

test("trusted device is invalid at expiration boundary", () => {
  const now = new Date("2026-09-16T12:00:00.000Z");
  assert.equal(isTrustedDeviceValid(now, null, now), false);
});
