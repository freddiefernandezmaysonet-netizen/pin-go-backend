type Reference = string | { id: string } | null | undefined;
type SubscriptionEvidence = {
  subscription?: Reference;
  parent?: { type?: string; subscription_details?: { subscription?: Reference } | null } | null;
};
export const stripeEvidenceId = (value: Reference) => typeof value === "string" ? value : value?.id ?? null;

// Stripe 2023 uses the top-level field; newer responses use parent. Conflicting
// claims must never attribute a fee to either subscription.
export function stripeEvidenceSubscription(value: SubscriptionEvidence): string | null {
  const legacy = stripeEvidenceId(value.subscription);
  const current = value.parent?.type === "subscription_details"
    ? stripeEvidenceId(value.parent.subscription_details?.subscription) : null;
  if (legacy && current && legacy !== current) return null;
  return current ?? legacy;
}
