import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
// Narrow provider contracts keep the runtime independent of canonical service imports.
export type CanonicalExtensionEstimateProviders = Readonly<{
  getOptions: (input: { guestToken: string; allowInStayExtension?: boolean }) => Promise<{
    managementPhase: string;
    reservation: { current: { checkIn: Date; checkOut: Date; adults: number; children: number; selectedAmenityIds: string[] } };
    property: { timezone: string | null; checkOutTime: string | null };
  }>;
  preview: (input: {
    guestToken: string; operation: "EXTEND_CHECKOUT_ONLY"; checkIn: Date; checkOut: Date;
    adults: number; children: number; selectedAmenityIds: string[];
  }) => Promise<{
    reservation: { currency: string };
    pricing: {
      currentTotalAmount: number; currentTotalAmountCents: number;
      amountDifference: number; amountDifferenceCents: number;
      proposed: { totalAmount: number; totalAmountCents: number };
    };
  }>;
}>;

/** Canary read path: shares the proposal preview without creating a proposal or a hold. */
export async function estimateCanonicalInStayExtension(
  guestToken: string,
  args: Readonly<Record<string, unknown>>,
  providers: CanonicalExtensionEstimateProviders,
): Promise<Readonly<Record<string, unknown>> | null> {
  const flags = { authorizationGranted: false, chargeExecuted: false, reservationChanged: false, proposalCreated: false, availabilityHeld: false };
  const nights = args.additionalNights;
  if (typeof nights !== "number" || !Number.isInteger(nights) || nights < 1 || nights > 30) {
    return { ...flags, decision: "INVALID_ADDITIONAL_NIGHTS", priceCalculated: false };
  }
  try {
    const options = await providers.getOptions({ guestToken, allowInStayExtension: true });
    if (options.managementPhase !== "IN_STAY") return null;
    const current = options.reservation.current;
    const timezone = options.property.timezone;
    const checkoutTime = options.property.checkOutTime;
    if (!timezone || !checkoutTime) throw new Error("EXTENSION_PROPERTY_TIME_REQUIRED");
    const currentKey = formatInTimeZone(current.checkOut, timezone, "yyyy-MM-dd");
    const calendar = new Date(`${currentKey}T00:00:00.000Z`);
    calendar.setUTCDate(calendar.getUTCDate() + nights);
    const proposedDate = calendar.toISOString().slice(0, 10);
    const proposedCheckOut = fromZonedTime(`${proposedDate}T${checkoutTime}:00`, timezone);
    const result = await providers.preview({
      guestToken, operation: "EXTEND_CHECKOUT_ONLY", checkIn: new Date(current.checkIn),
      checkOut: proposedCheckOut, adults: current.adults, children: current.children,
      selectedAmenityIds: [...current.selectedAmenityIds],
    });
    const pricing = result.pricing;
    return {
      ...flags, decision: "PRICE_CALCULATED_FOR_REVIEW", priceCalculated: true, priceIsEstimate: true,
      pricingBasis: "CANONICAL_IN_STAY_EXTENSION_PREVIEW", pricingReviewRequired: false,
      additionalNights: nights, currentCheckOut: current.checkOut, proposedCheckOut,
      currency: result.reservation.currency,
      currentReservationTotal: pricing.currentTotalAmount,
      currentReservationTotalCents: pricing.currentTotalAmountCents,
      additionalAmount: pricing.amountDifference, additionalAmountCents: pricing.amountDifferenceCents,
      proposedReservationTotal: pricing.proposed.totalAmount,
      proposedReservationTotalCents: pricing.proposed.totalAmountCents,
      note: "Read-only canonical extension estimate. No proposal, hold, reservation change or payment was created. A proposal requires a fresh preview and explicit guest confirmation.",
    };
  } catch {
    // Never fall back to a different pricing formula after canonical rejection.
    return { ...flags, decision: "PRICE_REQUIRES_HUMAN_REVIEW", priceCalculated: false, pricingReviewRequired: true, requiresHumanReview: true };
  }
}
