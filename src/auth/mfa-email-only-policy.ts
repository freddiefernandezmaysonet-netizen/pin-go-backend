import { normalizeOtpDestination } from "./mfa-otp.js";

export const PIN_GO_MFA_FACTOR = "EMAIL" as const;

export function normalizeMfaEmail(value: string): string {
  return normalizeOtpDestination("EMAIL", value);
}

export function isAllowedPinGoMfaFactor(value: unknown): value is typeof PIN_GO_MFA_FACTOR {
  return String(value ?? "").trim().toUpperCase() === PIN_GO_MFA_FACTOR;
}

export function assertAllowedPinGoMfaFactor(value: unknown): asserts value is typeof PIN_GO_MFA_FACTOR {
  if (!isAllowedPinGoMfaFactor(value)) {
    throw new Error("MFA_FACTOR_EMAIL_ONLY");
  }
}
