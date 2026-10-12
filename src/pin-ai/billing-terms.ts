// Version changes require renewed explicit acceptance; amounts are fixed server-side.
export const PIN_AI_BILLING_TERMS = Object.freeze({
  version: "pin-ai-connect-usd-1-reservation-v1",
  amountCents: 100,
  currency: "USD",
  appliesTo: ["ALL_RESERVATION_ORIGINS"],
  collectionMethod: "STRIPE_CONNECT_BALANCE_DEBIT",
  startsBeforeCheckInHours: 24,
  oncePerReservation: true,
  manualReservationsIncluded: true,
});

// New collection terms are opt-in. Legacy accrued evidence is never migrated.
export const PIN_AI_HYBRID_BILLING_TERMS = Object.freeze({
  version: "pin-ai-hybrid-usd-1-reservation-v2",
  amountCents: 100, currency: "USD", appliesTo: ["ALL_RESERVATION_ORIGINS"],
  collectionMethod: "DIRECT_APPLICATION_FEE_OR_MEMBERSHIP",
  accruesAt: "RESERVATION_CREATED", oncePerReservation: true,
  manualReservationsIncluded: true, cancellationNetAmountCents: 0,
  startsBeforeCheckInHours: 24,
});
export function pinAIBillingTerms(env: Readonly<Record<string, string | undefined>>) {
  return env.PIN_AI_HYBRID_BILLING_ENABLED === "true" ? PIN_AI_HYBRID_BILLING_TERMS : PIN_AI_BILLING_TERMS;
}
export function pinAIHybridBillingAllows(env: Readonly<Record<string, string | undefined>>, organizationId: string) {
  const ids = (env.PIN_AI_HYBRID_BILLING_ORGANIZATION_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return !!organizationId && env.PIN_AI_HYBRID_BILLING_ENABLED === "true" &&
    (env.PIN_AI_ALL_ORGANIZATIONS_ENABLED === "true" || (!ids.includes("*") && ids.includes(organizationId)));
}
