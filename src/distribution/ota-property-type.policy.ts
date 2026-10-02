/** Map the host's persisted listing type to Channex's billing-aware property type. */
const types: Record<string, { type: string; category: "hotel" | "vacation_rental" }> = {
  HOUSE: { type: "holiday_home", category: "vacation_rental" },
  APARTMENT: { type: "apartment", category: "vacation_rental" },
  CONDO: { type: "apartment", category: "vacation_rental" },
  CABIN: { type: "chalet", category: "vacation_rental" },
  COTTAGE: { type: "country_house", category: "vacation_rental" },
  VILLA: { type: "villa", category: "vacation_rental" },
  TOWNHOUSE: { type: "holiday_home", category: "vacation_rental" },
  BUNGALOW: { type: "holiday_home", category: "vacation_rental" },
  LOFT: { type: "apartment", category: "vacation_rental" },
  STUDIO: { type: "apartment", category: "vacation_rental" },
  GUESTHOUSE: { type: "guest_house", category: "hotel" },
  FARM_STAY: { type: "farm_stay", category: "vacation_rental" },
};
export function resolveOtaPropertyType(value: unknown) {
  const result = typeof value === "string" && Object.hasOwn(types, value) ? types[value] : null;
  if (!result) throw Object.assign(new Error("OTA_PROPERTY_TYPE_REQUIRED"), { code: "OTA_PROPERTY_TYPE_REQUIRED" });
  return result;
}
