import { evaluateE6EffectiveMode, type E6Environment } from "./mfa-canary-runtime.js";
import { resolveMfaEmailDeliveryMode } from "./mfa-email-otp-delivery.js";

export type E7Environment = E6Environment;

export type E7EffectiveMode = {
  mode: "OFF" | "SHADOW" | "CANARY" | "ENFORCE";
  ready: boolean;
  canarySelected: boolean;
  failClosed: boolean;
  reason:
    | "MFA_OFF"
    | "MFA_SHADOW"
    | "CANARY_ACTIVE"
    | "CANARY_USER_NOT_SELECTED"
    | "CANARY_ALLOWLIST_EMPTY"
    | "CANARY_PEPPER_MISSING"
    | "CANARY_DELIVERY_NOT_RESEND"
    | "INVALID_MODE"
    | "ENFORCE_ACTIVE"
    | "ENFORCE_PEPPER_MISSING"
    | "ENFORCE_DELIVERY_NOT_RESEND";
};

export function evaluateE7EffectiveMode(
  userId: string,
  env: E7Environment
): E7EffectiveMode {
  const configuredMode = String(env.PINGO_MFA_MODE ?? "")
    .trim()
    .toUpperCase();

  if (configuredMode === "ENFORCE") {
    if (String(env.PINGO_MFA_OTP_PEPPER ?? "").trim().length < 32) {
      return {
        mode: "ENFORCE",
        ready: false,
        canarySelected: false,
        failClosed: true,
        reason: "ENFORCE_PEPPER_MISSING",
      };
    }

    if (resolveMfaEmailDeliveryMode(env) !== "RESEND") {
      return {
        mode: "ENFORCE",
        ready: false,
        canarySelected: false,
        failClosed: true,
        reason: "ENFORCE_DELIVERY_NOT_RESEND",
      };
    }

    return {
      mode: "ENFORCE",
      ready: true,
      canarySelected: false,
      failClosed: true,
      reason: "ENFORCE_ACTIVE",
    };
  }

  const e6 = evaluateE6EffectiveMode(userId, env);

  return {
    mode: e6.mode,
    ready: e6.mode === "CANARY" ? e6.canaryReady : true,
    canarySelected: e6.canarySelected,
    failClosed: false,
    reason:
      e6.reason === "ENFORCE_BLOCKED"
        ? "INVALID_MODE"
        : e6.reason,
  };
}

export function requiresE7MfaChallenge(
  effective: E7EffectiveMode
): effective is E7EffectiveMode & { mode: "CANARY" | "ENFORCE"; ready: true } {
  return (
    effective.ready &&
    (effective.mode === "CANARY" || effective.mode === "ENFORCE")
  );
}
