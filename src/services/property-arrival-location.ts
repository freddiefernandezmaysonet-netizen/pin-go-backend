export type PropertyArrivalLocation = { complexName?: string | null; unitNumber?: string | null };

/** Optional private arrival details. Empty fields clear explicitly; omitted fields stay unchanged. */
export function parsePropertyArrivalLocation(input: Record<string, unknown>): PropertyArrivalLocation {
  const result: PropertyArrivalLocation = {};
  for (const [key, limit] of [["complexName", 120], ["unitNumber", 32]] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string") throw new Error(`${key} must be text`);
    const text = typeof value === "string" ? value.trim() : "";
    if (text.length > limit || /[\r\n\x00-\x1f\x7f]/.test(text)) throw new Error(`${key} is invalid`);
    result[key] = text || null;
  }
  return result;
}

export function formatPropertyArrivalLocation(property: PropertyArrivalLocation, language?: string | null): string {
  const complex = property.complexName?.trim();
  const unit = property.unitNumber?.trim();
  return [complex, unit ? `${language?.toLowerCase().startsWith("es") ? "Unidad" : "Unit"} ${unit}` : null].filter(Boolean).join(" · ");
}
