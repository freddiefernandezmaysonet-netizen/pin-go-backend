import { applyDefaultMarketSeasonsForProperty } from "./market-season-template.service";

export async function provisionProperty(propertyId: string) {
  return await applyDefaultMarketSeasonsForProperty(propertyId);
}