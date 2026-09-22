export type MarketPricingProviderKey = string;

export type MarketPricingPropertyDescriptor = {
  propertyId: string;
  latitude: number;
  longitude: number;
  country: string;
  region: string | null;
  city: string | null;
  timezone: string;
  currency: string;
  propertyType: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  maxGuests: number | null;
  amenityCodes: string[];
};

export type MarketPricingProviderRequest = {
  property: MarketPricingPropertyDescriptor;
  dateFrom: string;
  dateToExclusive: string;
  marketRadiusKm: number | null;
  maximumComparables: number;
};

export type MarketComparableCandidate = {
  externalListingId: string;
  listingName: string | null;
  latitude: number | null;
  longitude: number | null;
  distanceKm: number | null;
  similarityScore: number;
  propertyType: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  maxGuests: number | null;
  amenityCodes: string[];
  reviewScore: number | null;
  reviewCount: number | null;
  attributes: Record<string, unknown> | null;
};

export type MarketDailyObservation = {
  stayDate: string;
  currency: string;
  sampleSize: number;
  availableCount: number;
  lowerRate: number | null;
  medianRate: number;
  upperRate: number | null;
  providerSuggestedRate: number | null;
};

export type MarketPricingProviderResult = {
  provider: MarketPricingProviderKey;
  providerRequestId: string | null;
  observedAt: Date;
  expiresAt: Date;
  comparables: MarketComparableCandidate[];
  observations: MarketDailyObservation[];
  metadata: Record<string, unknown> | null;
};

export interface MarketPricingProvider {
  readonly key: MarketPricingProviderKey;

  fetchMarketPricing(
    request: MarketPricingProviderRequest
  ): Promise<MarketPricingProviderResult>;
}

export type MarketPricingProviderErrorCode =
  | "AUTHENTICATION_FAILED"
  | "INVALID_REQUEST"
  | "INVALID_RESPONSE"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "UNSUPPORTED_MARKET";

export class MarketPricingProviderError extends Error {
  readonly code: MarketPricingProviderErrorCode;
  readonly provider: MarketPricingProviderKey;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(input: {
    code: MarketPricingProviderErrorCode;
    provider: MarketPricingProviderKey;
    message: string;
    retryable: boolean;
    retryAfterMs?: number | null;
  }) {
    super(input.message);
    this.name = "MarketPricingProviderError";
    this.code = input.code;
    this.provider = input.provider;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs ?? null;
  }
}
