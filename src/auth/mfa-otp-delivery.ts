import type { OtpFactorType } from "./mfa-otp.js";

export type OtpDeliveryRequest = {
  type: OtpFactorType;
  destination: string;
  code: string;
  expiresInMinutes: number;
};

export type OtpDeliveryResult = {
  delivered: boolean;
  mode: "MOCK";
};

/**
 * E2 is intentionally no-send. Runtime provider delivery is a later authorized slice.
 * Keeping this adapter MOCK-only makes accidental external SMS/email impossible.
 */
export async function deliverMfaOtp(_request: OtpDeliveryRequest): Promise<OtpDeliveryResult> {
  return { delivered: false, mode: "MOCK" };
}
