import { constantTimeEqualHex, generateNumericOtp, hmacLowEntropySecret } from "./mfa-core.js";

export type OtpFactorType = "EMAIL" | "SMS";
export const MFA_OTP_TTL_MS = 5 * 60 * 1000;
export const MFA_OTP_MAX_ATTEMPTS = 5;
export const MFA_OTP_RESEND_COOLDOWN_MS = 60 * 1000;

export function normalizeOtpDestination(type: OtpFactorType, value: string): string {
  const raw = String(value ?? "").trim();
  if (type === "EMAIL") {
    const email = raw.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("INVALID_EMAIL_DESTINATION");
    return email;
  }

  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  throw new Error("INVALID_SMS_DESTINATION");
}

export function maskOtpDestination(type: OtpFactorType, value: string): string {
  const normalized = normalizeOtpDestination(type, value);
  if (type === "SMS") return `•••• ${normalized.slice(-4)}`;
  const [local, domain] = normalized.split("@");
  const visible = local.slice(0, Math.min(1, local.length));
  return `${visible}${"•".repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

export function createOtpMaterial(params: { challengeId: string; pepper: string }) {
  const code = generateNumericOtp();
  const otpHash = hmacLowEntropySecret(code, params.pepper, `MFA_OTP:${params.challengeId}`);
  return { code, otpHash };
}

export function verifyOtpMaterial(params: { challengeId: string; pepper: string; code: string; otpHash: string }) {
  if (!/^\d{6}$/.test(String(params.code ?? "").trim())) return false;
  const candidate = hmacLowEntropySecret(params.code, params.pepper, `MFA_OTP:${params.challengeId}`);
  return constantTimeEqualHex(candidate, params.otpHash);
}

export function otpExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + MFA_OTP_TTL_MS);
}

export function canResendOtp(lastSentAt: Date | null | undefined, now = new Date()): boolean {
  return !lastSentAt || now.getTime() - lastSentAt.getTime() >= MFA_OTP_RESEND_COOLDOWN_MS;
}
