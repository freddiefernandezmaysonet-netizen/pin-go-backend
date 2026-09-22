import type {
  MarketPricingProviderRequest,
  MarketPricingProviderResult,
} from "./market-pricing-provider.contract";

export type MarketPricingProviderValidationIssueCode =
  | "INVALID_REQUEST_RANGE"
  | "PROVIDER_MISMATCH"
  | "INVALID_REQUEST_ID"
  | "INVALID_TIMESTAMP"
  | "INVALID_EXPIRATION"
  | "INVALID_COLLECTION"
  | "TOO_MANY_COMPARABLES"
  | "DUPLICATE_COMPARABLE"
  | "INVALID_COMPARABLE"
  | "DUPLICATE_OBSERVATION"
  | "OBSERVATION_OUT_OF_RANGE"
  | "CURRENCY_MISMATCH"
  | "INVALID_OBSERVATION"
  | "INVALID_METADATA";

export type MarketPricingProviderValidationIssue = {
  code: MarketPricingProviderValidationIssueCode;
  path: string;
  message: string;
};

export type MarketPricingProviderValidationResult =
  | { valid: true; value: MarketPricingProviderResult }
  | { valid: false; issues: MarketPricingProviderValidationIssue[] };

type UnknownRecord = Record<string, unknown>;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isPositiveMoney(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isNullablePositiveMoney(value: unknown): value is number | null {
  return value === null || isPositiveMoney(value);
}

function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false;

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function hasValidStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  const normalized = value.map((item) =>
    typeof item === "string" ? item.trim() : ""
  );
  return normalized.every(Boolean) && new Set(normalized).size === normalized.length;
}

function validateComparable(
  value: unknown,
  index: number,
  issues: MarketPricingProviderValidationIssue[]
): string | null {
  const path = `comparables[${index}]`;
  if (!isRecord(value)) {
    issues.push({ code: "INVALID_COMPARABLE", path, message: "Comparable must be an object." });
    return null;
  }

  const id = value.externalListingId;
  if (typeof id !== "string" || id.trim().length === 0) {
    issues.push({ code: "INVALID_COMPARABLE", path: `${path}.externalListingId`, message: "Comparable ID is required." });
  }

  const nullableTextFields = ["listingName", "propertyType"] as const;
  for (const field of nullableTextFields) {
    if (value[field] !== null && typeof value[field] !== "string") {
      issues.push({ code: "INVALID_COMPARABLE", path: `${path}.${field}`, message: `${field} must be text or null.` });
    }
  }

  const latitude = value.latitude;
  const longitude = value.longitude;
  const hasLatitude = latitude !== null;
  const hasLongitude = longitude !== null;
  if (hasLatitude !== hasLongitude) {
    issues.push({ code: "INVALID_COMPARABLE", path, message: "Latitude and longitude must be supplied together." });
  } else if (
    hasLatitude &&
    (!isFiniteNumber(latitude) || latitude < -90 || latitude > 90 ||
      !isFiniteNumber(longitude) || longitude < -180 || longitude > 180)
  ) {
    issues.push({ code: "INVALID_COMPARABLE", path, message: "Comparable coordinates are outside valid bounds." });
  }

  if (value.distanceKm !== null && (!isFiniteNumber(value.distanceKm) || value.distanceKm < 0)) {
    issues.push({ code: "INVALID_COMPARABLE", path: `${path}.distanceKm`, message: "Distance must be non-negative or null." });
  }
  if (!isFiniteNumber(value.similarityScore) || value.similarityScore < 0 || value.similarityScore > 100) {
    issues.push({ code: "INVALID_COMPARABLE", path: `${path}.similarityScore`, message: "Similarity score must be between 0 and 100." });
  }

  for (const field of ["bedrooms", "bathrooms", "maxGuests"] as const) {
    if (value[field] !== null && (!isFiniteNumber(value[field]) || (value[field] as number) < 0)) {
      issues.push({ code: "INVALID_COMPARABLE", path: `${path}.${field}`, message: `${field} must be non-negative or null.` });
    }
  }

  if (!hasValidStringArray(value.amenityCodes)) {
    issues.push({ code: "INVALID_COMPARABLE", path: `${path}.amenityCodes`, message: "Amenity codes must be unique, non-empty strings." });
  }
  if (value.reviewScore !== null && (!isFiniteNumber(value.reviewScore) || value.reviewScore < 0 || value.reviewScore > 5)) {
    issues.push({ code: "INVALID_COMPARABLE", path: `${path}.reviewScore`, message: "Review score must be between 0 and 5 or null." });
  }
  if (value.reviewCount !== null && !isNonNegativeInteger(value.reviewCount)) {
    issues.push({ code: "INVALID_COMPARABLE", path: `${path}.reviewCount`, message: "Review count must be a non-negative integer or null." });
  }
  if (value.attributes !== null && !isRecord(value.attributes)) {
    issues.push({ code: "INVALID_COMPARABLE", path: `${path}.attributes`, message: "Attributes must be an object or null." });
  }

  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

function validateObservation(
  value: unknown,
  index: number,
  request: MarketPricingProviderRequest,
  issues: MarketPricingProviderValidationIssue[]
): string | null {
  const path = `observations[${index}]`;
  if (!isRecord(value)) {
    issues.push({ code: "INVALID_OBSERVATION", path, message: "Observation must be an object." });
    return null;
  }

  const stayDate = value.stayDate;
  if (!isValidIsoDate(stayDate)) {
    issues.push({ code: "INVALID_OBSERVATION", path: `${path}.stayDate`, message: "Stay date must be a real ISO calendar date." });
  } else if (stayDate < request.dateFrom || stayDate >= request.dateToExclusive) {
    issues.push({ code: "OBSERVATION_OUT_OF_RANGE", path: `${path}.stayDate`, message: "Stay date is outside the requested range." });
  }

  const expectedCurrency = request.property.currency.trim().toUpperCase();
  if (
    typeof value.currency !== "string" ||
    !CURRENCY_PATTERN.test(value.currency) ||
    value.currency !== expectedCurrency
  ) {
    issues.push({ code: "CURRENCY_MISMATCH", path: `${path}.currency`, message: "Observation currency does not match the property currency." });
  }

  if (!isPositiveInteger(value.sampleSize)) {
    issues.push({ code: "INVALID_OBSERVATION", path: `${path}.sampleSize`, message: "Sample size must be a positive integer." });
  }
  if (!isNonNegativeInteger(value.availableCount) || (isPositiveInteger(value.sampleSize) && value.availableCount > value.sampleSize)) {
    issues.push({ code: "INVALID_OBSERVATION", path: `${path}.availableCount`, message: "Available count must be an integer between zero and sample size." });
  }

  if (!isNullablePositiveMoney(value.lowerRate)) {
    issues.push({ code: "INVALID_OBSERVATION", path: `${path}.lowerRate`, message: "Lower rate must be positive or null." });
  }
  if (!isPositiveMoney(value.medianRate)) {
    issues.push({ code: "INVALID_OBSERVATION", path: `${path}.medianRate`, message: "Median rate must be positive." });
  }
  if (!isNullablePositiveMoney(value.upperRate)) {
    issues.push({ code: "INVALID_OBSERVATION", path: `${path}.upperRate`, message: "Upper rate must be positive or null." });
  }
  if (!isNullablePositiveMoney(value.providerSuggestedRate)) {
    issues.push({ code: "INVALID_OBSERVATION", path: `${path}.providerSuggestedRate`, message: "Suggested rate must be positive or null." });
  }

  if (isPositiveMoney(value.medianRate)) {
    if (isPositiveMoney(value.lowerRate) && value.lowerRate > value.medianRate) {
      issues.push({ code: "INVALID_OBSERVATION", path, message: "Lower rate cannot exceed median rate." });
    }
    if (isPositiveMoney(value.upperRate) && value.upperRate < value.medianRate) {
      issues.push({ code: "INVALID_OBSERVATION", path, message: "Upper rate cannot be below median rate." });
    }
  }

  return isValidIsoDate(stayDate) ? stayDate : null;
}

export function validateMarketPricingProviderResult(input: {
  expectedProvider: string;
  request: MarketPricingProviderRequest;
  result: unknown;
}): MarketPricingProviderValidationResult {
  const issues: MarketPricingProviderValidationIssue[] = [];
  const { expectedProvider, request, result } = input;

  if (
    !isValidIsoDate(request.dateFrom) ||
    !isValidIsoDate(request.dateToExclusive) ||
    request.dateFrom >= request.dateToExclusive
  ) {
    issues.push({ code: "INVALID_REQUEST_RANGE", path: "request", message: "Requested date range is invalid." });
  }

  if (!isRecord(result)) {
    return {
      valid: false,
      issues: [{ code: "INVALID_COLLECTION", path: "result", message: "Provider result must be an object." }, ...issues],
    };
  }

  if (typeof result.provider !== "string" || result.provider.trim() === "" || result.provider !== expectedProvider) {
    issues.push({ code: "PROVIDER_MISMATCH", path: "provider", message: "Provider identity does not match the configured provider." });
  }
  if (result.providerRequestId !== null && (typeof result.providerRequestId !== "string" || result.providerRequestId.trim() === "")) {
    issues.push({ code: "INVALID_REQUEST_ID", path: "providerRequestId", message: "Provider request ID must be non-empty text or null." });
  }

  const observedAt = result.observedAt;
  const expiresAt = result.expiresAt;
  if (!isValidDate(observedAt)) {
    issues.push({ code: "INVALID_TIMESTAMP", path: "observedAt", message: "Observed timestamp is invalid." });
  }
  if (!isValidDate(expiresAt)) {
    issues.push({ code: "INVALID_TIMESTAMP", path: "expiresAt", message: "Expiration timestamp is invalid." });
  } else if (isValidDate(observedAt) && expiresAt.getTime() <= observedAt.getTime()) {
    issues.push({ code: "INVALID_EXPIRATION", path: "expiresAt", message: "Expiration must be later than observation time." });
  }

  if (!Array.isArray(result.comparables)) {
    issues.push({ code: "INVALID_COLLECTION", path: "comparables", message: "Comparables must be an array." });
  } else {
    if (!isPositiveInteger(request.maximumComparables) || result.comparables.length > request.maximumComparables) {
      issues.push({ code: "TOO_MANY_COMPARABLES", path: "comparables", message: "Comparable count exceeds the configured limit." });
    }
    const seenComparableIds = new Set<string>();
    result.comparables.forEach((comparable, index) => {
      const id = validateComparable(comparable, index, issues);
      if (id && seenComparableIds.has(id)) {
        issues.push({ code: "DUPLICATE_COMPARABLE", path: `comparables[${index}].externalListingId`, message: "Comparable ID is duplicated." });
      } else if (id) {
        seenComparableIds.add(id);
      }
    });
  }

  if (!Array.isArray(result.observations) || result.observations.length === 0) {
    issues.push({ code: "INVALID_COLLECTION", path: "observations", message: "At least one daily observation is required." });
  } else {
    const seenStayDates = new Set<string>();
    result.observations.forEach((observation, index) => {
      const stayDate = validateObservation(observation, index, request, issues);
      if (stayDate && seenStayDates.has(stayDate)) {
        issues.push({ code: "DUPLICATE_OBSERVATION", path: `observations[${index}].stayDate`, message: "Stay date is duplicated." });
      } else if (stayDate) {
        seenStayDates.add(stayDate);
      }
    });
  }

  if (result.metadata !== null && !isRecord(result.metadata)) {
    issues.push({ code: "INVALID_METADATA", path: "metadata", message: "Metadata must be an object or null." });
  }

  return issues.length > 0
    ? { valid: false, issues }
    : { valid: true, value: result as MarketPricingProviderResult };
}
