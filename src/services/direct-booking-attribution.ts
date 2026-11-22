// URL campaign evidence is self-reported, not proof of a unique guest or an email click.
export const PRECHECKIN_BOOKING_CAMPAIGN = "precheckin_return_stay";
export function normalizeBookingCampaign(value: unknown): string | null {
  return value === PRECHECKIN_BOOKING_CAMPAIGN ? PRECHECKIN_BOOKING_CAMPAIGN : null;
}
export function bookingCampaignMetadata(value: unknown, cancellationHours: unknown): Record<string, string> {
  const campaign = normalizeBookingCampaign(value);
  // Swap one redundant display key for the campaign, preserving Stripe's key budget.
  // Cancellation hours remain in the canonical cancellationPolicySnapshot.
  return campaign ? { bookingCampaign: campaign }
    : { freeCancellationHoursBeforeCheckIn: String(cancellationHours) };
}
export function paidBookingAttribution(value: unknown) {
  const campaign = normalizeBookingCampaign(value);
  return campaign ? { source: "pingo", medium: "email", campaign, method: "tagged_url_v1" } : null;
}
