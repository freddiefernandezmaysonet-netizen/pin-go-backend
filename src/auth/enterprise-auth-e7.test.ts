import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  evaluateE7EffectiveMode,
  requiresE7MfaChallenge,
} from "./mfa-global-runtime.js";

const pepper = "e7-pepper-" + "x".repeat(64);

function configuredEnvironment() {
  return {
    PINGO_MFA_MODE: "ENFORCE",
    PINGO_MFA_CANARY_USER_IDS: "user-canary",
    PINGO_MFA_OTP_PEPPER: pepper,
    PINGO_MFA_EMAIL_DELIVERY: "RESEND",
    RESEND_API_KEY: "test-api-key",
    EMAIL_FROM: "Pin&Go <security@example.com>",
  };
}

test("E7 ENFORCE applies to every user without allowlist dependency", () => {
  const first = evaluateE7EffectiveMode("user-1", configuredEnvironment());
  const second = evaluateE7EffectiveMode("user-99", configuredEnvironment());

  for (const result of [first, second]) {
    assert.equal(result.mode, "ENFORCE");
    assert.equal(result.ready, true);
    assert.equal(result.failClosed, true);
    assert.equal(result.reason, "ENFORCE_ACTIVE");
    assert.equal(requiresE7MfaChallenge(result), true);
  }
});

test("E7 ENFORCE fails closed when OTP pepper is missing", () => {
  const result = evaluateE7EffectiveMode("user-1", {
    ...configuredEnvironment(),
    PINGO_MFA_OTP_PEPPER: "short",
  });

  assert.equal(result.mode, "ENFORCE");
  assert.equal(result.ready, false);
  assert.equal(result.failClosed, true);
  assert.equal(result.reason, "ENFORCE_PEPPER_MISSING");
  assert.equal(requiresE7MfaChallenge(result), false);
});

test("E7 ENFORCE fails closed when email delivery is not RESEND", () => {
  const result = evaluateE7EffectiveMode("user-1", {
    ...configuredEnvironment(),
    PINGO_MFA_EMAIL_DELIVERY: "MOCK",
  });

  assert.equal(result.mode, "ENFORCE");
  assert.equal(result.ready, false);
  assert.equal(result.failClosed, true);
  assert.equal(result.reason, "ENFORCE_DELIVERY_NOT_RESEND");
});

test("E7 preserves certified CANARY selection semantics", () => {
  const env = {
    ...configuredEnvironment(),
    PINGO_MFA_MODE: "CANARY",
    PINGO_MFA_CANARY_USER_IDS: "user-canary",
  };

  const selected = evaluateE7EffectiveMode("user-canary", env);
  const other = evaluateE7EffectiveMode("user-other", env);

  assert.equal(selected.mode, "CANARY");
  assert.equal(selected.ready, true);
  assert.equal(requiresE7MfaChallenge(selected), true);
  assert.equal(other.mode, "SHADOW");
  assert.equal(requiresE7MfaChallenge(other), false);
});

test("E7 login route contains fail-closed ENFORCE and legacy CANARY fail-open", () => {
  const source = readFileSync("src/routes/auth.routes.ts", "utf8");

  assert.match(source, /mfa-e7-enforce\] FAIL_CLOSED/);
  assert.match(source, /MFA_NOT_CONFIGURED/);
  assert.match(source, /MFA_DELIVERY_FAILED/);
  assert.match(source, /mfa-e6-canary\] FAIL_OPEN_TO_LEGACY/);
  assert.match(source, /e6Runtime\.mode === "SHADOW"/);
});

test("E7 direct organization registration no longer issues an auth session", () => {
  const source = readFileSync("src/routes/auth.routes.ts", "utf8");
  const marker = 'authRouter.post("/api/auth/register-organization"';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1);

  const registerSource = source.slice(start);
  assert.doesNotMatch(registerSource, /signSessionBoundAuthToken\(/);
  assert.doesNotMatch(registerSource, /signAuthToken\(/);
  assert.doesNotMatch(registerSource, /Set-Cookie/);
  assert.match(registerSource, /requiresLogin:\s*true/);

  const totalTokenIssues = source.match(/signSessionBoundAuthToken\(/g) ?? [];
  assert.equal(totalTokenIssues.length, 1);
});

test("E7 Stripe signup success never auto-logs a new account in", () => {
  const source = readFileSync("src/routes/public.signup.success.routes.ts", "utf8");

  assert.doesNotMatch(source, /signAuthToken/);
  assert.doesNotMatch(source, /signSessionBoundAuthToken/);
  assert.doesNotMatch(source, /buildAuthCookie/);
  assert.doesNotMatch(source, /Set-Cookie/);
  assert.match(source, /autoLoggedIn:\s*false/);
  assert.match(source, /requiresLogin:\s*true/);
});

test("E7 MFA verify supports both CANARY and ENFORCE challenge contexts", () => {
  const source = readFileSync("src/auth/mfa-login.routes.ts", "utf8");

  assert.match(source, /evaluateE7EffectiveMode/);
  assert.match(source, /requiresE7MfaChallenge/);
  assert.match(source, /"CANARY" \| "ENFORCE"/);
  assert.match(source, /MFA_NOT_CONFIGURED/);
});
