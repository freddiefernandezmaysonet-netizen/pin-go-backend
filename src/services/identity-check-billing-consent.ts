export function getIdentityCheckFeeCents(env: Readonly<Record<string, string | undefined>> = process.env) {
  const rawAmount = Number(env.DIRECT_BOOKING_PROTECTION_FEE_AMOUNT ?? "2.50");
  if (!Number.isFinite(rawAmount) || rawAmount < 0 || !Number.isSafeInteger(Math.round(rawAmount * 100))) {
    throw new Error("DIRECT_BOOKING_PROTECTION_FEE_AMOUNT_INVALID");
  }
  return Math.round(rawAmount * 100);
}
export function identityCheckBillingTerms(env: Readonly<Record<string, string | undefined>> = process.env) {
  const amountCents = getIdentityCheckFeeCents(env);
  return { version: `identity-check-direct-booking-usd-${amountCents}-v1`, amountCents,
    currency: "USD" as const, collectionMethod: "DIRECT_BOOKING_APPLICATION_FEE" as const,
    reservationScope: "DIRECT_BOOKING" as const };
}
type Evidence = { identityBillingTermsVersion: string | null; identityBillingAmountCents: number | null;
  identityBillingAcceptedAt: Date | null; identityBillingAcceptedBy: string | null };
export function validIdentityBillingConsent(evidence: Evidence | null, terms: ReturnType<typeof identityCheckBillingTerms>) {
  return !!evidence && evidence.identityBillingTermsVersion === terms.version &&
    evidence.identityBillingAmountCents === terms.amountCents && !!evidence.identityBillingAcceptedAt && !!evidence.identityBillingAcceptedBy;
}
export function resolveIdentityBillingConsent(input: { existing: Evidence | null; requiresIdentityVerification: boolean;
  acceptedTermsVersion: unknown; terms: ReturnType<typeof identityCheckBillingTerms>; actorId: string; now: Date }) {
  if (validIdentityBillingConsent(input.existing, input.terms)) return {
    identityBillingTermsVersion: input.existing!.identityBillingTermsVersion,
    identityBillingAmountCents: input.existing!.identityBillingAmountCents,
    identityBillingAcceptedAt: input.existing!.identityBillingAcceptedAt,
    identityBillingAcceptedBy: input.existing!.identityBillingAcceptedBy,
  };
  if (input.requiresIdentityVerification) {
    if (input.acceptedTermsVersion !== input.terms.version) throw new Error("IDENTITY_BILLING_TERMS_REQUIRED");
    return { identityBillingTermsVersion: input.terms.version, identityBillingAmountCents: input.terms.amountCents,
      identityBillingAcceptedAt: input.now, identityBillingAcceptedBy: input.actorId };
  }
  return { identityBillingTermsVersion: input.existing?.identityBillingTermsVersion ?? null,
    identityBillingAmountCents: input.existing?.identityBillingAmountCents ?? null,
    identityBillingAcceptedAt: input.existing?.identityBillingAcceptedAt ?? null,
    identityBillingAcceptedBy: input.existing?.identityBillingAcceptedBy ?? null };
}
