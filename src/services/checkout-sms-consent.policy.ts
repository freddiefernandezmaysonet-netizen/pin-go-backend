import { isGuestOperationalSmsEligible } from "./guest-journey-access-communications-bridge.policy";

export type CheckoutSmsConsentDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "GUEST_SMS_DISABLED"
        | "SMS_CONSENT_NOT_GRANTED";
    };

export function evaluateCheckoutSmsConsent(
  externalRaw: unknown,
  env: NodeJS.ProcessEnv = process.env,
  provenance: { externalProvider?: string | null; externalId?: string | null } = {}
): CheckoutSmsConsentDecision {
  if (env.GUEST_SMS_ENABLED !== "1") {
    return {
      allowed: false,
      reason: "GUEST_SMS_DISABLED",
    };
  }

  if (!isGuestOperationalSmsEligible({ ...provenance, externalRaw })) {
    return {
      allowed: false,
      reason: "SMS_CONSENT_NOT_GRANTED",
    };
  }

  return { allowed: true };
}
