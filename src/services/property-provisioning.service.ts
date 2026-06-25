import { applyDefaultMarketSeasonsForProperty } from "./market-season-template.service";
import { applyDefaultHolidayPricingForProperty } from "./holiday-pricing-template.service";

export async function provisionProperty(propertyId: string) {
  const seasonsResult = await applyDefaultMarketSeasonsForProperty(propertyId);
  const holidayPricingResult = await applyDefaultHolidayPricingForProperty(propertyId);

  return {
    seasonsResult,
    holidayPricingResult,
  };
}