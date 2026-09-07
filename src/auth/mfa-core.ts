import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export type MfaRolloutMode = "OFF" | "SHADOW" | "ENFORCE";
export type MfaFactorType = "PASSKEY" | "TOTP" | "SMS" | "EMAIL";
export type MfaAdmissionAction = "BYPASS" | "SHADOW" | "CHALLENGE" | "DENY";

export type MfaAdmissionInput = {
  mode: MfaRolloutMode;
  userActive: boolean;
  hasVerifiedFactor: boolean;
  trustedDeviceValid: boolean;
};

export type MfaAdmissionDecision = {
  action: MfaAdmissionAction;
  reason:
    | "MFA_OFF"
    | "MFA_SHADOW"
    | "TRUSTED_DEVICE"
    | "MFA_REQUIRED"
    | "NO_VERIFIED_FACTOR"
    | "USER_DISABLED";
};

export type ChallengeState = {
  expiresAt: Date;
  attemptCount: number;
  maxAttempts: number;
  consumedAt?: Date | null;
};

export function parseMfaRolloutMode(value: unknown): MfaRolloutMode {
  const normalized = String(value ?? "OFF").trim().toUpperCase();
  if (normalized === "OFF" || normalized === "SHADOW" || normalized === "ENFORCE") {
    return normalized;
  }
  throw new Error(`Invalid MFA rollout mode: ${normalized || "<empty>"}`);
}

export function evaluateMfaAdmission(input: MfaAdmissionInput): MfaAdmissionDecision {
  if (!input.userActive) {
    return { action: "DENY", reason: "USER_DISABLED" };
  }

  if (input.mode === "OFF") {
    return { action: "BYPASS", reason: "MFA_OFF" };
  }

  if (input.mode === "SHADOW") {
    return { action: "SHADOW", reason: "MFA_SHADOW" };
  }

  if (input.trustedDeviceValid) {
    return { action: "BYPASS", reason: "TRUSTED_DEVICE" };
  }

  if (!input.hasVerifiedFactor) {
    return { action: "DENY", reason: "NO_VERIFIED_FACTOR" };
  }

  return { action: "CHALLENGE", reason: "MFA_REQUIRED" };
}

export function generateOpaqueToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16) {
    throw new Error("Opaque token entropy must be at least 16 bytes");
  }
  return randomBytes(bytes).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  const value = String(token ?? "").trim();
  if (!value) throw new Error("Token is required");
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function generateNumericOtp(): string {
  return String(randomInt(100000, 1000000));
}

export function hmacLowEntropySecret(value: string, pepper: string, purpose: string): string {
  const normalizedValue = String(value ?? "").trim();
  const normalizedPepper = String(pepper ?? "").trim();
  const normalizedPurpose = String(purpose ?? "").trim();

  if (!normalizedValue) throw new Error("Secret value is required");
  if (normalizedPepper.length < 32) throw new Error("MFA pepper must be at least 32 characters");
  if (!normalizedPurpose) throw new Error("Purpose is required");

  return createHmac("sha256", normalizedPepper)
    .update(`${normalizedPurpose}:${normalizedValue}`, "utf8")
    .digest("hex");
}

export function constantTimeEqualHex(left: string, right: string): boolean {
  try {
    const a = Buffer.from(left, "hex");
    const b = Buffer.from(right, "hex");
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function isChallengeUsable(state: ChallengeState, now = new Date()): boolean {
  if (state.consumedAt) return false;
  if (state.expiresAt.getTime() <= now.getTime()) return false;
  if (state.attemptCount >= state.maxAttempts) return false;
  return true;
}

export function nextAttemptCount(state: ChallengeState): number {
  if (!Number.isInteger(state.attemptCount) || !Number.isInteger(state.maxAttempts)) {
    throw new Error("Challenge attempt counters must be integers");
  }
  if (state.attemptCount < 0 || state.maxAttempts < 1) {
    throw new Error("Invalid challenge attempt counters");
  }
  return Math.min(state.attemptCount + 1, state.maxAttempts);
}
