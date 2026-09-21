export type GooglePlacesSearchInput = Readonly<{
  query: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  maxResults: number;
  languageCode: "en" | "es";
}>;

export type GooglePlacesSearchResult = Readonly<{
  provider: "GOOGLE_PLACES";
  places: readonly Readonly<{
    name: string;
    category: string | null;
    formattedAddress: string | null;
    googleMapsUri: string | null;
    businessStatus: string | null;
    straightLineDistanceMeters: number;
    currentOpeningStatus: "NOT_REQUESTED";
  }>[];
}>;

type GooglePlacesFetch = (
  input: string,
  init: Readonly<{
    method: "POST";
    headers: Readonly<Record<string, string>>;
    body: string;
  }>,
) => Promise<Readonly<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>>;

const GOOGLE_PLACES_TEXT_SEARCH_URL =
  "https://places.googleapis.com/v1/places:searchText";
const GOOGLE_PLACES_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.primaryTypeDisplayName",
  "places.formattedAddress",
  "places.location",
  "places.businessStatus",
  "places.googleMapsUri",
].join(",");

export async function searchGooglePlaces(
  input: GooglePlacesSearchInput,
  options: Readonly<{
    apiKey?: string;
    fetchImpl?: GooglePlacesFetch;
  }> = {},
): Promise<GooglePlacesSearchResult> {
  const apiKey = String(
    options.apiKey ?? process.env.GOOGLE_MAPS_SERVER_API_KEY ?? "",
  ).trim();
  if (!apiKey) {
    throw new Error("PIN_AI_RUNTIME_GOOGLE_PLACES_API_KEY_MISSING");
  }

  const fetchImpl = options.fetchImpl ?? defaultGooglePlacesFetch;
  const response = await fetchImpl(GOOGLE_PLACES_TEXT_SEARCH_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": GOOGLE_PLACES_FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: input.query,
      pageSize: input.maxResults,
      languageCode: input.languageCode,
      locationBias: {
        circle: {
          center: {
            latitude: input.latitude,
            longitude: input.longitude,
          },
          radius: input.radiusMeters,
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`PIN_AI_RUNTIME_GOOGLE_PLACES_HTTP_${response.status}`);
  }

  const payload = asRecord(await response.json());
  const places = Array.isArray(payload.places) ? payload.places : [];

  return {
    provider: "GOOGLE_PLACES",
    places: places
      .map((value) => normalizePlace(value, input))
      .filter((place): place is NonNullable<typeof place> => place !== null)
      .filter(
        (place) => place.straightLineDistanceMeters <= input.radiusMeters,
      )
      .slice(0, input.maxResults),
  };
}

function normalizePlace(
  value: unknown,
  origin: GooglePlacesSearchInput,
): GooglePlacesSearchResult["places"][number] | null {
  const place = asRecord(value);
  const displayName = asRecord(place.displayName);
  const category = asRecord(place.primaryTypeDisplayName);
  const location = asRecord(place.location);
  const name = typeof displayName.text === "string"
    ? displayName.text.trim()
    : "";
  const latitude = finiteNumber(location.latitude);
  const longitude = finiteNumber(location.longitude);

  if (!name || latitude === null || longitude === null) return null;

  return {
    name,
    category:
      typeof category.text === "string" && category.text.trim()
        ? category.text.trim()
        : null,
    formattedAddress:
      typeof place.formattedAddress === "string" &&
      place.formattedAddress.trim()
        ? place.formattedAddress.trim()
        : null,
    googleMapsUri:
      typeof place.googleMapsUri === "string" && place.googleMapsUri.trim()
        ? place.googleMapsUri.trim()
        : null,
    businessStatus:
      typeof place.businessStatus === "string" && place.businessStatus.trim()
        ? place.businessStatus.trim()
        : null,
    straightLineDistanceMeters: Math.round(
      haversineDistanceMeters(
        origin.latitude,
        origin.longitude,
        latitude,
        longitude,
      ),
    ),
    currentOpeningStatus: "NOT_REQUESTED",
  };
}

function haversineDistanceMeters(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const earthRadiusMeters = 6_371_000;
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(latitudeB - latitudeA);
  const longitudeDelta = radians(longitudeB - longitudeA);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(latitudeA)) *
      Math.cos(radians(latitudeB)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

const defaultGooglePlacesFetch: GooglePlacesFetch = async (input, init) => {
  const response = await fetch(input, init);
  return {
    ok: response.ok,
    status: response.status,
    json: async () => response.json(),
  };
};
