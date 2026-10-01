export type StaffLanguage = "en" | "es";

export function resolveStaffLanguage(value: unknown): StaffLanguage {
  return String(value ?? "").trim().toLowerCase() === "es" ? "es" : "en";
}

export function parseStaffLanguage(value: unknown): StaffLanguage {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "en" || normalized === "es") return normalized;
  throw new Error("STAFF_PREFERRED_LANGUAGE_INVALID");
}

export function getStaffIntlLocale(language: StaffLanguage): "en-US" | "es-US" {
  return language === "es" ? "es-US" : "en-US";
}
