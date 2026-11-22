import { prisma } from "../lib/prisma";
import { calculateDirectBookingPricing } from "./direct-booking-pricing.service";
import { calculateAccommodationDiscount, applyAccommodationDiscountToQuote, defaultDiscountConfig, discountConfigSchema, type DiscountConfig } from "./direct-booking-discounts.policy";

export async function calculateDiscountedDirectQuote(
  input: Parameters<typeof calculateDirectBookingPricing>[0],
  previewConfig?: DiscountConfig,
) {
  const [pricing, property] = await Promise.all([
    calculateDirectBookingPricing(input),
    prisma.property.findUniqueOrThrow({ where: { id: input.propertyId }, select: {
      timezone: true, directDiscountConfig: true,
    } }),
  ]);
  const config = previewConfig ?? (property.directDiscountConfig
    ? discountConfigSchema.parse(property.directDiscountConfig.config) : defaultDiscountConfig);
  const discount = calculateAccommodationDiscount({ config, subtotal: pricing.nightlySubtotal,
    stayDates: pricing.nightlyRates.map(r => r.date), checkIn: input.checkIn,
    now: new Date(), timeZone: property.timezone || "America/Puerto_Rico",
  });
  return { ...applyAccommodationDiscountToQuote(pricing, discount), discountPolicySnapshot: config };
}
