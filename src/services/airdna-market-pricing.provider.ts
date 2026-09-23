import {
  MarketPricingProviderError,
  type MarketComparableCandidate,
  type MarketDailyObservation,
  type MarketPricingProvider,
  type MarketPricingProviderRequest,
  type MarketPricingProviderResult,
} from "./market-pricing-provider.contract";

const AIRDNA_PROVIDER_KEY = "airdna";
const DEFAULT_API_ORIGIN = "https://api.airdna.co/api/enterprise/v2";
const DEFAULT_RADIUS_KM = 10;
const MAX_RADIUS_METERS = 100_000;
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

type UnknownRecord = Record<string, unknown>;

export type AirDnaHttpResponse = Readonly<{
  status: number;
  headers?: Readonly<Record<string, string | undefined>>;
  data: unknown;
}>;

export type AirDnaHttpTransport = Readonly<{
  post(input: {
    url: string;
    headers: Readonly<Record<string, string>>;
    body: unknown;
  }): Promise<AirDnaHttpResponse>;
}>;

export type AirDnaMarketPricingProviderOptions = Readonly<{
  enabled?: boolean;
  apiKey?: string;
  apiOrigin?: string;
  transport?: AirDnaHttpTransport;
  clock?: () => Date;
}>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeCurrency(value: string): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(normalized)) {
    throw providerError("INVALID_REQUEST", "AirDNA currency is invalid.", false);
  }
  return normalized;
}

function normalizeOrigin(value: string | undefined): string {
  const origin = String(value ?? DEFAULT_API_ORIGIN).trim().replace(/\/+$/, "");
  if (!/^https:\/\/api\.airdna\.co\/api\/enterprise\/v2$/.test(origin)) {
    throw providerError("INVALID_REQUEST", "AirDNA API origin is invalid.", false);
  }
  return origin;
}

function providerError(
  code: ConstructorParameters<typeof MarketPricingProviderError>[0]["code"],
  message: string,
  retryable: boolean,
  retryAfterMs?: number | null,
) {
  return new MarketPricingProviderError({
    code,
    provider: AIRDNA_PROVIDER_KEY,
    message,
    retryable,
    retryAfterMs,
  });
}

function retryAfterMs(headers: Readonly<Record<string, string | undefined>> | undefined) {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

function mapHttpError(response: AirDnaHttpResponse): never {
  if (response.status === 401 || response.status === 403) {
    throw providerError("AUTHENTICATION_FAILED", "AirDNA authentication failed.", false);
  }
  if (response.status === 400 || response.status === 422) {
    throw providerError("INVALID_REQUEST", "AirDNA rejected the market pricing request.", false);
  }
  if (response.status === 404) {
    throw providerError("UNSUPPORTED_MARKET", "AirDNA returned no supported market for this property.", false);
  }
  if (response.status === 429) {
    throw providerError(
      "RATE_LIMITED",
      "AirDNA rate limit reached.",
      true,
      retryAfterMs(response.headers),
    );
  }
  throw providerError("UNAVAILABLE", "AirDNA market data is temporarily unavailable.", true);
}

function defaultTransport(): AirDnaHttpTransport {
  return {
    async post(input) {
      const response = await fetch(input.url, {
        method: "POST",
        headers: input.headers,
        body: JSON.stringify(input.body),
      });
      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return { status: response.status, headers, data };
    },
  };
}

function amenityCodes(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => key.replace(/^has_/, "").trim())
    .filter(Boolean)
    .sort();
}

function similarityScore(input: {
  distanceMeters: number | null;
  radiusMeters: number;
  bedrooms: number | null;
  expectedBedrooms: number | null;
  bathrooms: number | null;
  expectedBathrooms: number | null;
  maxGuests: number | null;
  expectedMaxGuests: number | null;
}): number {
  const distanceScore =
    input.distanceMeters === null
      ? 50
      : Math.max(0, 100 - (input.distanceMeters / input.radiusMeters) * 100);
  const featureScores: number[] = [];

  for (const [actual, expected] of [
    [input.bedrooms, input.expectedBedrooms],
    [input.bathrooms, input.expectedBathrooms],
    [input.maxGuests, input.expectedMaxGuests],
  ] as const) {
    if (actual === null || expected === null) continue;
    const denominator = Math.max(1, Math.abs(expected));
    featureScores.push(Math.max(0, 100 - (Math.abs(actual - expected) / denominator) * 100));
  }

  const featureScore =
    featureScores.length > 0
      ? featureScores.reduce((sum, score) => sum + score, 0) / featureScores.length
      : distanceScore;

  return Math.round((distanceScore * 0.6 + featureScore * 0.4) * 100) / 100;
}

function mapComparable(
  value: unknown,
  request: MarketPricingProviderRequest,
  radiusMeters: number,
): MarketComparableCandidate | null {
  if (!isRecord(value)) return null;
  const externalListingId = text(value.property_id);
  if (!externalListingId) return null;

  const location = isRecord(value.location) ? value.location : null;
  const latitude = location ? finite(location.lat) : null;
  const longitude = location ? finite(location.lng) : null;
  const distanceMeters = finite(value.distance);
  const bedrooms = finite(value.bedrooms);
  const bathrooms = finite(value.bathrooms);
  const maxGuests = finite(value.accommodates);
  const ratings = isRecord(value.ratings) ? value.ratings : null;
  const reviewScore =
    finite(value.rating) ?? (ratings ? finite(ratings.overall_rating) : null);
  const reviews = finite(value.reviews);
  const reviewCount =
    reviews !== null && Number.isInteger(reviews) && reviews >= 0 ? reviews : null;

  return {
    externalListingId,
    listingName: text(value.title),
    latitude,
    longitude,
    distanceKm:
      distanceMeters !== null && distanceMeters >= 0
        ? Math.round((distanceMeters / 1000) * 1000) / 1000
        : null,
    similarityScore: similarityScore({
      distanceMeters,
      radiusMeters,
      bedrooms,
      expectedBedrooms: request.property.bedrooms,
      bathrooms,
      expectedBathrooms: request.property.bathrooms,
      maxGuests,
      expectedMaxGuests: request.property.maxGuests,
    }),
    propertyType: text(value.property_type),
    bedrooms,
    bathrooms,
    maxGuests,
    amenityCodes: amenityCodes(value.amenities),
    reviewScore,
    reviewCount,
    attributes: {
      marketId: text(value.market_id),
      marketName: text(value.market_name),
      listingType: text(value.listing_type),
      averageDailyRateLtm: finite(value.average_daily_rate_ltm),
      occupancyRateLtm: finite(value.occupancy_rate_ltm),
    },
  };
}

function dominantMarketId(listings: unknown[]): string | null {
  const counts = new Map<string, number>();
  for (const value of listings) {
    if (!isRecord(value)) continue;
    const marketId = text(value.market_id);
    if (!marketId) continue;
    counts.set(marketId, (counts.get(marketId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

function mapObservation(
  value: unknown,
  request: MarketPricingProviderRequest,
): MarketDailyObservation | null {
  if (!isRecord(value)) return null;
  const stayDate = text(value.date);
  if (
    !stayDate ||
    stayDate < request.dateFrom ||
    stayDate >= request.dateToExclusive
  ) {
    return null;
  }

  const availableCount = finite(value.available_count);
  const bookedCount = finite(value.booked_count);
  const medianAvailableRate = finite(value.median_available_rate);
  if (
    availableCount === null ||
    bookedCount === null ||
    !Number.isInteger(availableCount) ||
    !Number.isInteger(bookedCount) ||
    availableCount < 0 ||
    bookedCount < 0 ||
    medianAvailableRate === null ||
    medianAvailableRate <= 0
  ) {
    return null;
  }

  const sampleSize = availableCount + bookedCount;
  if (sampleSize <= 0) return null;

  return {
    stayDate,
    currency: request.property.currency.trim().toUpperCase(),
    sampleSize,
    availableCount,
    lowerRate: null,
    medianRate: Math.round(medianAvailableRate * 100) / 100,
    upperRate: null,
    providerSuggestedRate: null,
  };
}

function listingFilters(request: MarketPricingProviderRequest) {
  const filters: Array<{ field: string; type: "select"; value: number | string }> = [];
  if (request.property.bedrooms !== null) {
    filters.push({ field: "bedrooms", type: "select", value: request.property.bedrooms });
  }
  if (request.property.bathrooms !== null) {
    filters.push({ field: "bathrooms", type: "select", value: request.property.bathrooms });
  }
  if (request.property.maxGuests !== null) {
    filters.push({ field: "accommodates", type: "select", value: request.property.maxGuests });
  }
  if (request.property.propertyType) {
    filters.push({
      field: "property_type",
      type: "select",
      value: request.property.propertyType.trim().toLowerCase(),
    });
  }
  return filters;
}

function requestedMonths(dateFrom: string, dateToExclusive: string): number {
  const start = new Date(`${dateFrom}T00:00:00.000Z`);
  const end = new Date(`${dateToExclusive}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    throw providerError("INVALID_REQUEST", "AirDNA date range is invalid.", false);
  }
  const days = Math.ceil((end.getTime() - start.getTime()) / 86_400_000);
  return Math.min(12, Math.max(1, Math.ceil(days / 30)));
}

export function createAirDnaMarketPricingProvider(
  options: AirDnaMarketPricingProviderOptions = {},
): MarketPricingProvider {
  const enabled = options.enabled === true;
  const apiOrigin = normalizeOrigin(options.apiOrigin);
  const apiKey = String(options.apiKey ?? "").trim();
  const transport = options.transport ?? defaultTransport();
  const clock = options.clock ?? (() => new Date());

  if (enabled && !apiKey) {
    throw providerError("AUTHENTICATION_FAILED", "AirDNA API key is required when the provider is enabled.", false);
  }

  return {
    key: AIRDNA_PROVIDER_KEY,

    async fetchMarketPricing(request): Promise<MarketPricingProviderResult> {
      if (!enabled) {
        throw providerError("UNAVAILABLE", "AirDNA provider is disabled.", false);
      }

      const currency = normalizeCurrency(request.property.currency);
      const radiusMeters = Math.min(
        MAX_RADIUS_METERS,
        Math.max(
          1,
          Math.round((request.marketRadiusKm ?? DEFAULT_RADIUS_KM) * 1000),
        ),
      );
      const pageSize = positiveInteger(request.maximumComparables);
      if (!pageSize || pageSize > 50) {
        throw providerError("INVALID_REQUEST", "AirDNA comparable limit is invalid.", false);
      }

      const headers = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
      const filters = listingFilters(request);
      const compsResponse = await transport.post({
        url: `${apiOrigin}/listing/comps/area`,
        headers,
        body: {
          lat: request.property.latitude,
          lng: request.property.longitude,
          radius: radiusMeters,
          pagination: { page_size: pageSize, offset: 0 },
          currency,
          sort_order: "proximity",
          sort_direction: "ascending",
          ...(filters.length > 0 ? { filters } : {}),
        },
      });
      if (compsResponse.status < 200 || compsResponse.status >= 300) {
        mapHttpError(compsResponse);
      }
      if (!isRecord(compsResponse.data)) {
        throw providerError("INVALID_RESPONSE", "AirDNA comps response is invalid.", false);
      }
      const compsPayload = isRecord(compsResponse.data.payload)
        ? compsResponse.data.payload
        : null;
      const listings = compsPayload && Array.isArray(compsPayload.listings)
        ? compsPayload.listings
        : null;
      if (!listings) {
        throw providerError("INVALID_RESPONSE", "AirDNA comps payload is missing listings.", false);
      }

      const marketId = dominantMarketId(listings);
      if (!marketId) {
        throw providerError("UNSUPPORTED_MARKET", "AirDNA comps did not identify a market.", false);
      }

      const futureResponse = await transport.post({
        url: `${apiOrigin}/market/${encodeURIComponent(marketId)}/future_pricing`,
        headers,
        body: {
          num_months: requestedMonths(request.dateFrom, request.dateToExclusive),
          ...(filters.length > 0 ? { filters } : {}),
          currency,
        },
      });
      if (futureResponse.status < 200 || futureResponse.status >= 300) {
        mapHttpError(futureResponse);
      }
      if (!isRecord(futureResponse.data)) {
        throw providerError("INVALID_RESPONSE", "AirDNA future pricing response is invalid.", false);
      }
      const futurePayload = isRecord(futureResponse.data.payload)
        ? futureResponse.data.payload
        : null;
      const metrics = futurePayload && Array.isArray(futurePayload.metrics)
        ? futurePayload.metrics
        : null;
      if (!metrics) {
        throw providerError("INVALID_RESPONSE", "AirDNA future pricing payload is missing metrics.", false);
      }

      const comparables = listings
        .map((listing) => mapComparable(listing, request, radiusMeters))
        .filter((value): value is MarketComparableCandidate => value !== null)
        .slice(0, pageSize);
      const observations = metrics
        .map((metric) => mapObservation(metric, request))
        .filter((value): value is MarketDailyObservation => value !== null);

      if (comparables.length === 0 || observations.length === 0) {
        throw providerError("INVALID_RESPONSE", "AirDNA returned insufficient market evidence.", false);
      }

      const observedAt = clock();
      if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) {
        throw providerError("INVALID_RESPONSE", "AirDNA provider clock is invalid.", false);
      }

      const responseEnvelope = isRecord(futureResponse.data.status)
        ? futureResponse.data.status
        : null;
      const providerRequestId = text(responseEnvelope?.response_id);

      return {
        provider: AIRDNA_PROVIDER_KEY,
        providerRequestId,
        observedAt,
        expiresAt: new Date(observedAt.getTime() + SNAPSHOT_TTL_MS),
        comparables,
        observations,
        metadata: {
          marketId,
          comparableCount: comparables.length,
          source: "airdna-enterprise-v2",
        },
      };
    },
  };
}
