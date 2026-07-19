export type GuestLanguage = "en" | "es";

export function resolveGuestLanguage(value: unknown): GuestLanguage {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace("_", "-");

  return normalized === "es" || normalized.startsWith("es-")
    ? "es"
    : "en";
}

export function getGuestIntlLocale(language: GuestLanguage) {
  return language === "es" ? "es-US" : "en-US";
}
