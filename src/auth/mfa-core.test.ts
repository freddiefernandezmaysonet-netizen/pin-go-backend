import assert from "node:assert/strict";
import test from "node:test";
import {
  constantTimeEqualHex,
  evaluateMfaAdmission,
  generateNumericOtp,
  generateOpaqueToken,
  hashOpaqueToken,
  hmacLowEntropySecret,
  isChallengeUsable,
  nextAttemptCount,
  parseMfaRolloutMode,
} from "./mfa-core.js";

const pepper = "0123456789abcdef0123456789abcdef";

test("rollout defaults to OFF", () => {
  assert.equal(parseMfaRolloutMode(undefined), "OFF");
});

test("rollout accepts SHADOW", () => {
  assert.equal(parseMfaRolloutMode("shadow"), "SHADOW");
});

test("rollout accepts ENFORCE", () => {
  assert.equal(parseMfaRolloutMode("ENFORCE"), "ENFORCE");
});

test("rollout rejects unknown values", () => {
  assert.throws(() => parseMfaRolloutMode("on"));
});

test("disabled users are denied in every mode", () => {
  assert.deepEqual(
    evaluateMfaAdmission({ mode: "OFF", userActive: false, hasVerifiedFactor: true, trustedDeviceValid: true }),
    { action: "DENY", reason: "USER_DISABLED" }
  );
});

test("OFF preserves legacy admission", () => {
  assert.deepEqual(
    evaluateMfaAdmission({ mode: "OFF", userActive: true, hasVerifiedFactor: false, trustedDeviceValid: false }),
    { action: "BYPASS", reason: "MFA_OFF" }
  );
});

test("SHADOW never blocks an active user", () => {
  assert.deepEqual(
    evaluateMfaAdmission({ mode: "SHADOW", userActive: true, hasVerifiedFactor: false, trustedDeviceValid: false }),
    { action: "SHADOW", reason: "MFA_SHADOW" }
  );
});

test("ENFORCE honors a valid trusted device", () => {
  assert.deepEqual(
    evaluateMfaAdmission({ mode: "ENFORCE", userActive: true, hasVerifiedFactor: true, trustedDeviceValid: true }),
    { action: "BYPASS", reason: "TRUSTED_DEVICE" }
  );
});

test("ENFORCE challenges users with a verified factor", () => {
  assert.deepEqual(
    evaluateMfaAdmission({ mode: "ENFORCE", userActive: true, hasVerifiedFactor: true, trustedDeviceValid: false }),
    { action: "CHALLENGE", reason: "MFA_REQUIRED" }
  );
});

test("ENFORCE fails closed without a verified factor", () => {
  assert.deepEqual(
    evaluateMfaAdmission({ mode: "ENFORCE", userActive: true, hasVerifiedFactor: false, trustedDeviceValid: false }),
    { action: "DENY", reason: "NO_VERIFIED_FACTOR" }
  );
});

test("opaque tokens contain at least 128 bits of entropy", () => {
  const token = generateOpaqueToken(16);
  assert.ok(token.length >= 22);
  assert.notEqual(token, generateOpaqueToken(16));
});

test("opaque token hashing is deterministic", () => {
  const token = "sample-token";
  assert.equal(hashOpaqueToken(token), hashOpaqueToken(token));
});

test("OTP is always six numeric digits", () => {
  for (let i = 0; i < 100; i += 1) assert.match(generateNumericOtp(), /^\d{6}$/);
});

test("low entropy secrets are purpose-bound by HMAC", () => {
  const sms = hmacLowEntropySecret("123456", pepper, "SMS_OTP");
  const recovery = hmacLowEntropySecret("123456", pepper, "RECOVERY_CODE");
  assert.notEqual(sms, recovery);
  assert.equal(constantTimeEqualHex(sms, hmacLowEntropySecret("123456", pepper, "SMS_OTP")), true);
});

test("expired, consumed, and exhausted challenges fail closed", () => {
  const now = new Date("2026-09-07T02:00:00.000Z");
  assert.equal(isChallengeUsable({ expiresAt: new Date("2026-09-07T01:59:59.000Z"), attemptCount: 0, maxAttempts: 5 }, now), false);
  assert.equal(isChallengeUsable({ expiresAt: new Date("2026-09-07T02:05:00.000Z"), attemptCount: 0, maxAttempts: 5, consumedAt: now }, now), false);
  assert.equal(isChallengeUsable({ expiresAt: new Date("2026-09-07T02:05:00.000Z"), attemptCount: 5, maxAttempts: 5 }, now), false);
});

test("challenge attempts saturate at the configured maximum", () => {
  assert.equal(nextAttemptCount({ expiresAt: new Date(Date.now() + 1000), attemptCount: 0, maxAttempts: 5 }), 1);
  assert.equal(nextAttemptCount({ expiresAt: new Date(Date.now() + 1000), attemptCount: 5, maxAttempts: 5 }), 5);
});
