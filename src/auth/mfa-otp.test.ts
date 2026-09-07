import assert from "node:assert/strict";
import test from "node:test";
import {
  MFA_OTP_MAX_ATTEMPTS,
  MFA_OTP_RESEND_COOLDOWN_MS,
  MFA_OTP_TTL_MS,
  canResendOtp,
  createOtpMaterial,
  maskOtpDestination,
  normalizeOtpDestination,
  otpExpiresAt,
  verifyOtpMaterial,
} from "./mfa-otp.js";

const pepper = "0123456789abcdef0123456789abcdef";

test("normalizes email", () => assert.equal(normalizeOtpDestination("EMAIL", " Host@Example.COM "), "host@example.com"));
test("normalizes PR/US phone", () => assert.equal(normalizeOtpDestination("SMS", "787-555-1212"), "+17875551212"));
test("rejects invalid destination", () => assert.throws(() => normalizeOtpDestination("SMS", "123")));
test("masks email", () => assert.match(maskOtpDestination("EMAIL", "host@example.com"), /^h•+@example\.com$/));
test("masks SMS", () => assert.equal(maskOtpDestination("SMS", "+17875551212"), "•••• 1212"));
test("OTP material is six digits and challenge-bound", () => {
  const material = createOtpMaterial({ challengeId: "challenge-a", pepper });
  assert.match(material.code, /^\d{6}$/);
  assert.equal(verifyOtpMaterial({ challengeId: "challenge-a", pepper, code: material.code, otpHash: material.otpHash }), true);
  assert.equal(verifyOtpMaterial({ challengeId: "challenge-b", pepper, code: material.code, otpHash: material.otpHash }), false);
});
test("invalid OTP format fails closed", () => {
  const material = createOtpMaterial({ challengeId: "c", pepper });
  assert.equal(verifyOtpMaterial({ challengeId: "c", pepper, code: "12345", otpHash: material.otpHash }), false);
});
test("TTL is five minutes", () => {
  const now = new Date("2026-09-07T14:00:00.000Z");
  assert.equal(otpExpiresAt(now).getTime() - now.getTime(), MFA_OTP_TTL_MS);
});
test("resend cooldown is enforced", () => {
  const now = new Date("2026-09-07T14:00:00.000Z");
  assert.equal(canResendOtp(new Date(now.getTime() - MFA_OTP_RESEND_COOLDOWN_MS + 1), now), false);
  assert.equal(canResendOtp(new Date(now.getTime() - MFA_OTP_RESEND_COOLDOWN_MS), now), true);
});
test("maximum attempts remains five", () => assert.equal(MFA_OTP_MAX_ATTEMPTS, 5));
