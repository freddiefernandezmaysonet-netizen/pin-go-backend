export type WebSearchLocation = Readonly<{
  city: string;
  region: string;
  country: string;
  timezone: string;
  label: string;
}>;

export type StoredPropertyLocation = Readonly<{
  source: "PERSISTED_PROPERTY";
  latitude: number;
  longitude: number;
  city: string;
  region: string;
  country: string;
}>;

export function resolveStoredPropertyLocation(input: Readonly<{
  latitude?: unknown;
  longitude?: unknown;
  city: string | null;
  region: string | null;
  country: string | null;
  timezone: string | null;
}>): StoredPropertyLocation | null {
  const coordinate = (value: unknown, min: number, max: number) => {
    if (value == null || typeof value === "boolean" ||
        (typeof value === "string" && !value.trim())) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
  };
  const latitude = coordinate(input.latitude, -90, 90);
  const longitude = coordinate(input.longitude, -180, 180);
  if (latitude === null || longitude === null) return null;
  const { city, region, country } = resolveWebSearchLocation(input);
  return { source: "PERSISTED_PROPERTY", latitude, longitude, city, region, country };
}

export function resolveWebSearchLocation(input: Readonly<{
  city: string | null;
  region: string | null;
  country: string | null;
  timezone: string | null;
}>): WebSearchLocation {
  const city = boundedLocationPart(input.city);
  const region = boundedLocationPart(input.region);
  const timezone = boundedLocationPart(input.timezone);
  const country = normalizeCountry(input.country) || countryFromTimezone(timezone);

  return {
    city,
    region,
    country,
    timezone,
    label: [city, region, country].filter(Boolean).join(", "),
  };
}

function boundedLocationPart(value: string | null): string {
  return String(value ?? "").trim().slice(0, 100);
}

function normalizeCountry(value: string | null): string {
  const country = boundedLocationPart(value);
  if (/^(puerto rico|pr)$/i.test(country)) return "PR";
  return /^[a-z]{2}$/i.test(country) ? country.toUpperCase() : "";
}

function countryFromTimezone(timezone: string): string {
  return timezone === "America/Puerto_Rico" ? "PR" : "";
}
