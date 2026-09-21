export type WebSearchLocation = Readonly<{
  city: string;
  region: string;
  country: string;
  timezone: string;
  label: string;
}>;

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
