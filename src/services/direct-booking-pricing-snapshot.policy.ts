import type { calculateDirectBookingPricing } from "./direct-booking-pricing.service";
type Pricing = Awaited<ReturnType<typeof calculateDirectBookingPricing>>;
export function validatePaidPricingSnapshot(snapshot: {
  propertyId: string; checkIn: Date; checkOut: Date; pricing: unknown;
} | null, payment: { propertyId: string; checkIn: Date; checkOut: Date; amountTotal: number | null; currency: string | null }): Pricing {
  if (!snapshot || snapshot.propertyId !== payment.propertyId ||
    snapshot.checkIn.getTime() !== payment.checkIn.getTime() || snapshot.checkOut.getTime() !== payment.checkOut.getTime()) {
    throw new Error("DIRECT_BOOKING_PRICING_SNAPSHOT_MISMATCH");
  }
  const pricing = snapshot.pricing as Pricing | null;
  if (!pricing || !Number.isSafeInteger(pricing.totalAmountCents) || pricing.totalAmountCents <= 0 ||
    pricing.totalAmountCents !== payment.amountTotal || Math.round(pricing.totalAmount * 100) !== payment.amountTotal ||
    pricing.currency !== payment.currency) throw new Error("DIRECT_BOOKING_PAID_AMOUNT_MISMATCH");
  return pricing;
}
