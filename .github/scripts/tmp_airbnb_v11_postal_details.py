from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected anchor once, found {count}: {old[:80]!r}")
    p.write_text(text.replace(old, new, 1))


def replace_n(path: str, old: str, new: str, expected: int) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"{path}: expected anchor {expected} times, found {count}: {old[:80]!r}")
    p.write_text(text.replace(old, new))


# Property schema: additive nullable global postal code.
replace_once(
    "prisma/schema.prisma",
    "  region                     String?\n  country                    String?\n  timezone                   String?\n",
    "  region                     String?\n  country                    String?\n  postalCode                 String?\n  timezone                   String?\n",
)

migration = Path("prisma/migrations/20260911153000_add_property_postal_code/migration.sql")
migration.parent.mkdir(parents=True, exist_ok=True)
migration.write_text('-- AlterTable\nALTER TABLE "Property" ADD COLUMN "postalCode" TEXT;\n')

# Legacy/current property create + list + patch route.
replace_once(
    "src/routes/properties.route.ts",
    '          country: p.country ?? "",\n          timezone: p.timezone ?? "",\n',
    '          country: p.country ?? "",\n          postalCode: p.postalCode ?? "",\n          timezone: p.timezone ?? "",\n',
)
replace_once(
    "src/routes/properties.route.ts",
    'const {\n  name,\n  address1,\n  city,\n  region,\n  country,\n  timezone,\n  checkInTime,',
    'const {\n  name,\n  address1,\n  city,\n  region,\n  country,\n  postalCode,\n  timezone,\n  checkInTime,',
)
replace_once(
    "src/routes/properties.route.ts",
    '          country: country?.trim() || null,\n          timezone: timezone?.trim() || "America/Puerto_Rico",\n',
    '          country: country?.trim() || null,\n          postalCode: postalCode?.trim() || null,\n          timezone: timezone?.trim() || "America/Puerto_Rico",\n',
)
replace_once(
    "src/routes/properties.route.ts",
    '        region,\n        country,\n        timezone,\n        checkInTime,',
    '        region,\n        country,\n        postalCode,\n        timezone,\n        checkInTime,',
)
replace_once(
    "src/routes/properties.route.ts",
    '          ...(country !== undefined ? { country: country?.trim() || null } : {}),\n          ...(timezone !== undefined\n',
    '          ...(country !== undefined ? { country: country?.trim() || null } : {}),\n          ...(postalCode !== undefined\n            ? { postalCode: String(postalCode || "").trim() || null }\n            : {}),\n          ...(timezone !== undefined\n',
)

# Dashboard property read/edit contract.
replace_n(
    "src/routes/dashboard.properties.route.ts",
    '          country: true,\n          timezone: true,\n',
    '          country: true,\n          postalCode: true,\n          timezone: true,\n',
    2,
)
replace_once(
    "src/routes/dashboard.properties.route.ts",
    '  region,\n  country,\n  timezone,\n  cleaningDurationMinutes,',
    '  region,\n  country,\n  postalCode,\n  timezone,\n  cleaningDurationMinutes,',
)
replace_once(
    "src/routes/dashboard.properties.route.ts",
    '      if (country !== undefined) {\n        data.country = String(country || "").trim() || null;\n      }\n\n      if (timezone !== undefined) {',
    '      if (country !== undefined) {\n        data.country = String(country || "").trim() || null;\n      }\n\n      if (postalCode !== undefined) {\n        data.postalCode = String(postalCode || "").trim() || null;\n      }\n\n      if (timezone !== undefined) {',
)

Path("src/distribution/airbnb-property-auto-matching.ts").write_text(r'''export type AirbnbPropertyMatchStatus =
  | "AUTO_MATCH"
  | "REVIEW_REQUIRED"
  | "UNMATCHED";

export type AirbnbPropertyMatchConfidence = "HIGH" | "MEDIUM" | "LOW";

export type PinGoPropertyMatchInput = {
  id: string;
  name: string;
  publicTitle: string | null;
  city: string | null;
  country: string | null;
  postalCode: string | null;
  maxGuests: number | null;
};

export type AirbnbListingMatchInput = {
  id: string;
  title: string | null;
  city: string | null;
  countryCode: string | null;
  occupancies: number[] | null;
};

export type AirbnbListingDetailsEvidence = {
  listingId: string;
  personCapacity: number | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
};

export type AirbnbPropertyMatchDecision = {
  propertyId: string;
  status: AirbnbPropertyMatchStatus;
  confidence: AirbnbPropertyMatchConfidence;
  candidateListingId: string | null;
  candidateTitle: string | null;
  score: number;
  runnerUpScore: number | null;
  reasons: string[];
};

export type AirbnbPropertyPortfolioMatch = {
  decisions: AirbnbPropertyMatchDecision[];
  summary: {
    propertiesConsidered: number;
    listingsConsidered: number;
    autoMatched: number;
    reviewRequired: number;
    unmatched: number;
  };
};

type CandidateScore = {
  listing: AirbnbListingMatchInput;
  score: number;
  nameSimilarity: number;
  cityMismatch: boolean;
  countryMismatch: boolean;
  reasons: string[];
};

const AUTO_MATCH_MIN_SCORE = 90;
const REVIEW_MIN_SCORE = 70;
const AUTO_MATCH_MIN_NAME_SIMILARITY = 0.9;
const AUTO_MATCH_MIN_MARGIN = 15;

const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  "puerto rico": "PR",
  pr: "PR",
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  us: "US",
  canada: "CA",
  ca: "CA",
  mexico: "MX",
  mx: "MX",
  spain: "ES",
  es: "ES",
  "dominican republic": "DO",
  do: "DO",
  "united kingdom": "GB",
  uk: "GB",
  gb: "GB",
};

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(value: string): string[] {
  return value ? value.split(" ").filter(Boolean) : [];
}

function numericTokens(value: string): string[] {
  return tokens(value).filter((token) => /^\d+$/.test(token));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function bigrams(value: string): string[] {
  if (value.length < 2) return value ? [value] : [];
  const result: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    result.push(value.slice(index, index + 2));
  }
  return result;
}

function diceSimilarity(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const item of a) counts.set(item, (counts.get(item) ?? 0) + 1);
  let intersection = 0;
  for (const item of b) {
    const count = counts.get(item) ?? 0;
    if (count > 0) {
      intersection += 1;
      counts.set(item, count - 1);
    }
  }
  return (2 * intersection) / (a.length + b.length);
}

function tokenCoverage(left: string, right: string): number {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (a.size === 0 || b.size === 0) return 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  let overlap = 0;
  for (const token of smaller) if (larger.has(token)) overlap += 1;
  return overlap / smaller.size;
}

export function airbnbPropertyNameSimilarity(
  leftValue: string | null | undefined,
  rightValue: string | null | undefined
): number {
  const left = normalizeText(leftValue);
  const right = normalizeText(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  const coverage = tokenCoverage(left, right);
  const dice = diceSimilarity(left, right);
  let similarity = Math.max(dice, coverage >= 1 ? 0.94 : coverage * 0.9);

  if (coverage >= 1 && Math.min(leftTokens.length, rightTokens.length) === 1) {
    similarity = Math.min(similarity, 0.82);
  }

  const leftNumbers = numericTokens(left);
  const rightNumbers = numericTokens(right);
  if (!sameStringSet(leftNumbers, rightNumbers)) {
    similarity = Math.min(
      similarity,
      leftNumbers.length > 0 && rightNumbers.length > 0 ? 0.55 : 0.75
    );
  }

  return Math.max(0, Math.min(1, similarity));
}

function normalizeCountry(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  const alias = COUNTRY_ALIASES[normalized];
  if (alias) return alias;
  if (/^[a-z]{2}$/.test(normalized)) return normalized.toUpperCase();
  return normalized.toUpperCase();
}

function normalizePostalCode(value: string | null | undefined): string | null {
  const normalized = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return normalized || null;
}

function preferredNameSimilarity(
  property: PinGoPropertyMatchInput,
  listingTitle: string | null
): number {
  return Math.max(
    airbnbPropertyNameSimilarity(property.name, listingTitle),
    airbnbPropertyNameSimilarity(property.publicTitle, listingTitle)
  );
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function scoreCandidate(
  property: PinGoPropertyMatchInput,
  listing: AirbnbListingMatchInput
): CandidateScore {
  const nameSimilarity = preferredNameSimilarity(property, listing.title);
  let score = nameSimilarity * 70;
  const reasons: string[] = [];

  if (nameSimilarity === 1) reasons.push("NAME_EXACT");
  else if (nameSimilarity >= AUTO_MATCH_MIN_NAME_SIMILARITY) reasons.push("NAME_STRONG");
  else if (nameSimilarity >= 0.65) reasons.push("NAME_PARTIAL");
  else reasons.push("NAME_WEAK");

  const propertyCity = normalizeText(property.city);
  const listingCity = normalizeText(listing.city);
  const cityKnown = Boolean(propertyCity && listingCity);
  const cityMismatch = cityKnown && propertyCity !== listingCity;
  if (cityKnown && !cityMismatch) {
    score += 15;
    reasons.push("CITY_MATCH");
  } else if (cityMismatch) {
    reasons.push("CITY_MISMATCH");
  } else {
    reasons.push("CITY_UNKNOWN");
  }

  const propertyCountry = normalizeCountry(property.country);
  const listingCountry = normalizeCountry(listing.countryCode);
  const countryKnown = Boolean(propertyCountry && listingCountry);
  const countryMismatch = countryKnown && propertyCountry !== listingCountry;
  if (countryKnown && !countryMismatch) {
    score += 10;
    reasons.push("COUNTRY_MATCH");
  } else if (countryMismatch) {
    reasons.push("COUNTRY_MISMATCH");
  } else {
    reasons.push("COUNTRY_UNKNOWN");
  }

  return {
    listing,
    score: roundScore(score),
    nameSimilarity,
    cityMismatch,
    countryMismatch,
    reasons,
  };
}

function confidenceFor(score: number): AirbnbPropertyMatchConfidence {
  if (score >= AUTO_MATCH_MIN_SCORE) return "HIGH";
  if (score >= REVIEW_MIN_SCORE) return "MEDIUM";
  return "LOW";
}

function decideProperty(
  property: PinGoPropertyMatchInput,
  listings: readonly AirbnbListingMatchInput[]
): AirbnbPropertyMatchDecision {
  const candidates = listings
    .filter((listing) => Boolean(listing.title?.trim()))
    .map((listing) => scoreCandidate(property, listing))
    .sort((left, right) =>
      right.score - left.score || left.listing.id.localeCompare(right.listing.id)
    );

  const top = candidates[0];
  const runnerUp = candidates[1];
  if (!top) {
    return {
      propertyId: property.id,
      status: "UNMATCHED",
      confidence: "LOW",
      candidateListingId: null,
      candidateTitle: null,
      score: 0,
      runnerUpScore: null,
      reasons: ["NO_LISTING_CANDIDATE"],
    };
  }

  const runnerUpScore = runnerUp?.score ?? null;
  const margin = runnerUp ? top.score - runnerUp.score : Number.POSITIVE_INFINITY;
  const canAutoMatch =
    top.score >= AUTO_MATCH_MIN_SCORE &&
    top.nameSimilarity >= AUTO_MATCH_MIN_NAME_SIMILARITY &&
    !top.cityMismatch &&
    !top.countryMismatch &&
    margin >= AUTO_MATCH_MIN_MARGIN;

  const reasons = [...top.reasons];
  if (runnerUp && margin < AUTO_MATCH_MIN_MARGIN) reasons.push("AMBIGUOUS_RUNNER_UP");

  if (canAutoMatch) {
    return {
      propertyId: property.id,
      status: "AUTO_MATCH",
      confidence: "HIGH",
      candidateListingId: top.listing.id,
      candidateTitle: top.listing.title,
      score: top.score,
      runnerUpScore,
      reasons,
    };
  }

  if (top.score >= REVIEW_MIN_SCORE) {
    return {
      propertyId: property.id,
      status: "REVIEW_REQUIRED",
      confidence: confidenceFor(top.score),
      candidateListingId: top.listing.id,
      candidateTitle: top.listing.title,
      score: top.score,
      runnerUpScore,
      reasons,
    };
  }

  return {
    propertyId: property.id,
    status: "UNMATCHED",
    confidence: "LOW",
    candidateListingId: null,
    candidateTitle: null,
    score: top.score,
    runnerUpScore,
    reasons,
  };
}

function withReason(
  decision: AirbnbPropertyMatchDecision,
  reason: string
): AirbnbPropertyMatchDecision {
  return decision.reasons.includes(reason)
    ? decision
    : { ...decision, reasons: [...decision.reasons, reason] };
}

export function corroborateAirbnbPropertyMatch(args: {
  property: PinGoPropertyMatchInput;
  listing: AirbnbListingMatchInput;
  decision: AirbnbPropertyMatchDecision;
  details: AirbnbListingDetailsEvidence;
}): AirbnbPropertyMatchDecision {
  const { property, listing, decision, details } = args;
  if (
    decision.status !== "REVIEW_REQUIRED" ||
    !decision.candidateListingId ||
    decision.candidateListingId !== listing.id ||
    decision.candidateListingId !== details.listingId ||
    !decision.reasons.includes("CITY_MISMATCH") ||
    decision.reasons.includes("AMBIGUOUS_RUNNER_UP") ||
    decision.reasons.includes("LISTING_CONFLICT")
  ) {
    return decision;
  }

  if (preferredNameSimilarity(property, listing.title) < AUTO_MATCH_MIN_NAME_SIMILARITY) {
    return withReason(decision, "DETAILS_NAME_NOT_STRONG");
  }

  const propertyCountry = normalizeCountry(property.country);
  const detailsCountry = normalizeCountry(details.countryCode);
  if (!propertyCountry || !detailsCountry) {
    return withReason(decision, "DETAILS_COUNTRY_UNKNOWN");
  }
  if (propertyCountry !== detailsCountry) {
    return withReason(decision, "DETAILS_COUNTRY_MISMATCH");
  }

  const propertyPostalCode = normalizePostalCode(property.postalCode);
  const detailsPostalCode = normalizePostalCode(details.postalCode);
  if (!propertyPostalCode || !detailsPostalCode) {
    return withReason(decision, "POSTAL_CODE_UNKNOWN");
  }
  if (propertyPostalCode !== detailsPostalCode) {
    return withReason(decision, "POSTAL_CODE_MISMATCH");
  }

  let result = withReason(decision, "POSTAL_CODE_MATCH");
  if (property.maxGuests != null) {
    if (details.personCapacity == null) {
      return withReason(result, "PERSON_CAPACITY_UNKNOWN");
    }
    if (property.maxGuests !== details.personCapacity) {
      return withReason(result, "PERSON_CAPACITY_MISMATCH");
    }
    result = withReason(result, "PERSON_CAPACITY_MATCH");
  }

  result = withReason(result, "CITY_MISMATCH_CORROBORATED");
  return {
    ...result,
    status: "AUTO_MATCH",
    confidence: "HIGH",
    score: Math.max(result.score, 95),
  };
}

export function matchAirbnbPropertyPortfolio(args: {
  properties: readonly PinGoPropertyMatchInput[];
  listings: readonly AirbnbListingMatchInput[];
}): AirbnbPropertyPortfolioMatch {
  const decisions = args.properties.map((property) =>
    decideProperty(property, args.listings)
  );

  const byListing = new Map<string, number[]>();
  decisions.forEach((decision, index) => {
    if (decision.status === "UNMATCHED" || !decision.candidateListingId) return;
    const indexes = byListing.get(decision.candidateListingId) ?? [];
    indexes.push(index);
    byListing.set(decision.candidateListingId, indexes);
  });

  for (const indexes of byListing.values()) {
    if (indexes.length < 2) continue;
    for (const index of indexes) {
      const decision = decisions[index]!;
      decisions[index] = {
        ...decision,
        status: "REVIEW_REQUIRED",
        confidence: "MEDIUM",
        reasons: decision.reasons.includes("LISTING_CONFLICT")
          ? decision.reasons
          : [...decision.reasons, "LISTING_CONFLICT"],
      };
    }
  }

  return {
    decisions,
    summary: {
      propertiesConsidered: args.properties.length,
      listingsConsidered: args.listings.length,
      autoMatched: decisions.filter((decision) => decision.status === "AUTO_MATCH").length,
      reviewRequired: decisions.filter((decision) => decision.status === "REVIEW_REQUIRED").length,
      unmatched: decisions.filter((decision) => decision.status === "UNMATCHED").length,
    },
  };
}
''')

Path("src/distribution/airbnb-host-self-service.listings.http-transport.ts").write_text(r'''const ALLOWED_API_ORIGINS = new Set([
  "https://app.channex.io",
  "https://staging.channex.io",
]);

const MAX_RESPONSE_BYTES = 1_000_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AIRBNB_LISTING_ID = /^\d{1,32}$/;

export class AirbnbListingDiscoveryTransportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AirbnbListingDiscoveryTransportError";
  }
}

function exactOrigin(raw: string): string {
  try {
    const parsed = new URL(String(raw ?? "").trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      !ALLOWED_API_ORIGINS.has(parsed.origin)
    ) {
      throw new Error("invalid");
    }
    return parsed.origin;
  } catch {
    throw new AirbnbListingDiscoveryTransportError(
      "OTA_AIRBNB_LISTING_DISCOVERY_API_ORIGIN_INVALID"
    );
  }
}

function safeChannelId(value: string): string {
  const id = String(value ?? "").trim();
  if (!UUID.test(id)) {
    throw new AirbnbListingDiscoveryTransportError(
      "OTA_AIRBNB_CHANNEL_ID_INVALID"
    );
  }
  return id;
}

function safeListingId(value: string): string {
  const id = String(value ?? "").trim();
  if (!AIRBNB_LISTING_ID.test(id)) {
    throw new AirbnbListingDiscoveryTransportError(
      "OTA_AIRBNB_LISTING_ID_INVALID"
    );
  }
  return id;
}

function failure(status: number): AirbnbListingDiscoveryTransportError {
  if (status === 404) {
    return new AirbnbListingDiscoveryTransportError(
      "OTA_AIRBNB_LISTING_DISCOVERY_NOT_FOUND"
    );
  }
  if (status === 429) {
    return new AirbnbListingDiscoveryTransportError(
      "OTA_AIRBNB_LISTING_DISCOVERY_RATE_LIMITED"
    );
  }
  if (status >= 400 && status < 500) {
    return new AirbnbListingDiscoveryTransportError(
      "OTA_AIRBNB_LISTING_DISCOVERY_REQUEST_REJECTED"
    );
  }
  return new AirbnbListingDiscoveryTransportError(
    "OTA_AIRBNB_LISTING_DISCOVERY_PROVIDER_UNAVAILABLE"
  );
}

export function createAirbnbListingDiscoveryHttpTransport(args: {
  apiOrigin: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}) {
  const origin = exactOrigin(args.apiOrigin);
  const apiKey = String(args.apiKey ?? "").trim();
  if (!/^[\x21-\x7E]{1,512}$/.test(apiKey)) {
    throw new AirbnbListingDiscoveryTransportError(
      "OTA_AIRBNB_LISTING_DISCOVERY_CREDENTIALS_UNAVAILABLE"
    );
  }
  if (
    !Number.isInteger(args.timeoutMs) ||
    args.timeoutMs < 1_000 ||
    args.timeoutMs > 15_000
  ) {
    throw new AirbnbListingDiscoveryTransportError(
      "OTA_AIRBNB_LISTING_DISCOVERY_TIMEOUT_CONFIGURATION_INVALID"
    );
  }
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new AirbnbListingDiscoveryTransportError(
      "OTA_AIRBNB_LISTING_DISCOVERY_TRANSPORT_UNAVAILABLE"
    );
  }

  async function getJson(url: URL): Promise<unknown> {
    if (url.origin !== origin) {
      throw new AirbnbListingDiscoveryTransportError(
        "OTA_AIRBNB_LISTING_DISCOVERY_REQUEST_NOT_ALLOWED"
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "user-api-key": apiKey,
          },
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw new AirbnbListingDiscoveryTransportError(
          "OTA_AIRBNB_LISTING_DISCOVERY_PROVIDER_UNAVAILABLE"
        );
      }
      if (!response.ok) throw failure(response.status);

      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        throw new AirbnbListingDiscoveryTransportError(
          "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_TOO_LARGE"
        );
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new AirbnbListingDiscoveryTransportError(
          "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_TOO_LARGE"
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new AirbnbListingDiscoveryTransportError(
          "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async listAirbnbListings(channelId: string): Promise<unknown> {
      const id = safeChannelId(channelId);
      return await getJson(
        new URL(`/api/v1/channels/${encodeURIComponent(id)}/action/listings`, origin)
      );
    },

    async getAirbnbListingDetails(
      channelId: string,
      listingId: string
    ): Promise<unknown> {
      const id = safeChannelId(channelId);
      const safeId = safeListingId(listingId);
      const url = new URL(
        `/api/v1/channels/${encodeURIComponent(id)}/action/listing_details`,
        origin
      );
      url.searchParams.set("listing_id", safeId);
      return await getJson(url);
    },
  };
}
''')

Path("src/distribution/airbnb-host-self-service.listings.service.ts").write_text(r'''import { AirbnbHostSelfServiceError } from "./airbnb-host-self-service.service.js";
import {
  corroborateAirbnbPropertyMatch,
  matchAirbnbPropertyPortfolio,
  type AirbnbListingDetailsEvidence,
  type AirbnbPropertyMatchDecision,
  type PinGoPropertyMatchInput,
} from "./airbnb-property-auto-matching.js";

export type AirbnbListingSummary = {
  id: string;
  title: string | null;
  type: string | null;
  occupancies: number[] | null;
  synchronizationCategory: string | null;
  city: string | null;
  countryCode: string | null;
  qualityStatus: string | null;
};

export type AirbnbListingDiscoveryClient = {
  otaChannelConnection: {
    findFirst(args: unknown): Promise<{
      organizationId: string;
      propertyId: string;
      provider: string;
      externalConnectionId: string | null;
    } | null>;
  };
  property: {
    findMany(args: unknown): Promise<PinGoPropertyMatchInput[]>;
  };
};

export type AirbnbListingDiscoveryTransport = {
  listAirbnbListings(channelId: string): Promise<unknown>;
  getAirbnbListingDetails(channelId: string, listingId: string): Promise<unknown>;
};

export type AirbnbListingDiscoveryResult = {
  channelId: string;
  listings: AirbnbListingSummary[];
  match: AirbnbPropertyMatchDecision;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function required(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AirbnbHostSelfServiceError(code);
  }
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalInteger(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
    );
  }
  return value;
}

function optionalFiniteNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
    );
  }
  return value;
}

function optionalOccupancies(value: unknown): number[] | null {
  if (value == null) return null;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "number" || !Number.isInteger(item))
  ) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
    );
  }
  return [...value];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseAirbnbListingDiscoveryPayload(
  payload: unknown
): AirbnbListingSummary[] {
  const root = record(payload);
  const data = record(root?.data);
  const dictionary = record(data?.listing_id_dictionary);
  const values = dictionary?.values;
  if (!Array.isArray(values)) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
    );
  }

  return values.map((value) => {
    const listing = record(value);
    if (!listing) {
      throw new AirbnbHostSelfServiceError(
        "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
      );
    }
    return {
      id: required(
        listing.id,
        "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
      ),
      title: optionalText(listing.title),
      type: optionalText(listing.type),
      occupancies: optionalOccupancies(listing.occupancies),
      synchronizationCategory: optionalText(listing.synchronization_category),
      city: optionalText(listing.city),
      countryCode: optionalText(listing.country_code),
      qualityStatus: optionalText(listing.quality_status),
    };
  });
}

export function parseAirbnbListingDetailsPayload(
  payload: unknown
): AirbnbListingDetailsEvidence {
  const root = record(payload);
  const data = record(root?.data);
  const listing = record(data?.listing);
  if (!listing) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
    );
  }

  return {
    listingId: required(
      listing.id_str,
      "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
    ),
    personCapacity: optionalInteger(listing.person_capacity),
    city: optionalText(listing.city),
    state: optionalText(listing.state),
    postalCode: optionalText(listing.zipcode),
    countryCode: optionalText(listing.country_code),
    latitude: optionalFiniteNumber(listing.lat),
    longitude: optionalFiniteNumber(listing.lng),
  };
}

function appendReason(
  decision: AirbnbPropertyMatchDecision,
  reason: string
): AirbnbPropertyMatchDecision {
  return decision.reasons.includes(reason)
    ? decision
    : { ...decision, reasons: [...decision.reasons, reason] };
}

export async function discoverAirbnbListings(args: {
  client: AirbnbListingDiscoveryClient;
  transport: AirbnbListingDiscoveryTransport;
  organizationId: string;
  propertyId: string;
}): Promise<AirbnbListingDiscoveryResult> {
  const organizationId = required(
    args.organizationId,
    "OTA_AIRBNB_TENANT_INVALID"
  );
  const propertyId = required(args.propertyId, "OTA_AIRBNB_PROPERTY_INVALID");

  const connection = await args.client.otaChannelConnection.findFirst({
    where: {
      organizationId,
      propertyId,
      provider: "AIRBNB",
    },
    select: {
      organizationId: true,
      propertyId: true,
      provider: true,
      externalConnectionId: true,
    },
  });

  if (!connection) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_CONNECTION_NOT_FOUND"
    );
  }
  if (
    connection.organizationId !== organizationId ||
    connection.propertyId !== propertyId ||
    connection.provider !== "AIRBNB"
  ) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_LISTING_DISCOVERY_SCOPE_MISMATCH"
    );
  }

  const channelId = required(
    connection.externalConnectionId,
    "OTA_AIRBNB_CHANNEL_ID_UNAVAILABLE"
  );
  if (!UUID.test(channelId)) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_CHANNEL_ID_INVALID"
    );
  }

  const properties = await args.client.property.findMany({
    where: {
      organizationId,
      status: "ACTIVE",
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      name: true,
      publicTitle: true,
      city: true,
      country: true,
      postalCode: true,
      maxGuests: true,
    },
  });

  const property = properties.find((candidate) => candidate.id === propertyId);
  if (!property) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_PROPERTY_NOT_FOUND"
    );
  }

  const payload = await args.transport.listAirbnbListings(channelId);
  const listings = parseAirbnbListingDiscoveryPayload(payload);
  const portfolio = matchAirbnbPropertyPortfolio({ properties, listings });
  let match = portfolio.decisions.find(
    (decision) => decision.propertyId === propertyId
  );

  if (!match) {
    throw new AirbnbHostSelfServiceError(
      "OTA_AIRBNB_PROPERTY_MATCHING_FAILED"
    );
  }

  const shouldCorroborate =
    match.status === "REVIEW_REQUIRED" &&
    Boolean(match.candidateListingId) &&
    Boolean(property.postalCode?.trim()) &&
    match.reasons.includes("CITY_MISMATCH") &&
    !match.reasons.includes("AMBIGUOUS_RUNNER_UP") &&
    !match.reasons.includes("LISTING_CONFLICT");

  if (shouldCorroborate && match.candidateListingId) {
    const candidate = listings.find(
      (listing) => listing.id === match!.candidateListingId
    );
    if (candidate) {
      try {
        const detailsPayload = await args.transport.getAirbnbListingDetails(
          channelId,
          match.candidateListingId
        );
        const details = parseAirbnbListingDetailsPayload(detailsPayload);
        match = corroborateAirbnbPropertyMatch({
          property,
          listing: candidate,
          decision: match,
          details,
        });
      } catch {
        match = appendReason(match, "DETAILS_UNAVAILABLE");
      }
    }
  }

  return {
    channelId,
    listings,
    match,
  };
}
''')

Path("src/distribution/airbnb-property-auto-matching.test.ts").write_text(r'''import assert from "node:assert/strict";
import test from "node:test";

import {
  airbnbPropertyNameSimilarity,
  corroborateAirbnbPropertyMatch,
  matchAirbnbPropertyPortfolio,
  type AirbnbListingMatchInput,
  type PinGoPropertyMatchInput,
} from "./airbnb-property-auto-matching.js";

function property(
  overrides: Partial<PinGoPropertyMatchInput> = {}
): PinGoPropertyMatchInput {
  return {
    id: "property-1",
    name: "Casa Collores",
    publicTitle: null,
    city: "Collores",
    country: "Puerto Rico",
    postalCode: "00771",
    maxGuests: 2,
    ...overrides,
  };
}

function listing(
  overrides: Partial<AirbnbListingMatchInput> = {}
): AirbnbListingMatchInput {
  return {
    id: "551126434553599406",
    title: "Casa Collores",
    city: "Collores",
    countryCode: "PR",
    occupancies: [1, 2],
    ...overrides,
  };
}

test("normalizes text but protects numeric and generic-name identity", () => {
  assert.equal(airbnbPropertyNameSimilarity("Casa Collorés", "CASA COLLORES"), 1);
  assert.ok(
    airbnbPropertyNameSimilarity(
      "Casa Collores",
      "Casa Collores - Mountain Retreat"
    ) >= 0.9
  );
  assert.ok(airbnbPropertyNameSimilarity("Villa 1", "Villa 2") <= 0.55);
  assert.ok(airbnbPropertyNameSimilarity("Villa", "Villa del Mar") < 0.9);
});

test("auto-matches Casa Collores when the summary is a unique exact candidate", () => {
  const result = matchAirbnbPropertyPortfolio({
    properties: [property()],
    listings: [listing()],
  });

  assert.deepEqual(result.summary, {
    propertiesConsidered: 1,
    listingsConsidered: 1,
    autoMatched: 1,
    reviewRequired: 0,
    unmatched: 0,
  });
  assert.equal(result.decisions[0]?.status, "AUTO_MATCH");
  assert.equal(result.decisions[0]?.confidence, "HIGH");
  assert.equal(result.decisions[0]?.candidateListingId, "551126434553599406");
  assert.equal(result.decisions[0]?.score, 95);
  assert.ok(result.decisions[0]?.reasons.includes("NAME_EXACT"));
  assert.ok(result.decisions[0]?.reasons.includes("CITY_MATCH"));
  assert.ok(result.decisions[0]?.reasons.includes("COUNTRY_MATCH"));
});

test("occupancy options are not treated as exact person capacity", () => {
  const decision = matchAirbnbPropertyPortfolio({
    properties: [property({ maxGuests: 2 })],
    listings: [listing({ occupancies: [1, 2, 3, 4] })],
  }).decisions[0]!;

  assert.equal(decision.status, "AUTO_MATCH");
  assert.equal(decision.score, 95);
  assert.equal(decision.reasons.includes("MAX_GUESTS_MISMATCH"), false);
});

test("known city or country contradictions require review", () => {
  const cityMismatch = matchAirbnbPropertyPortfolio({
    properties: [property()],
    listings: [listing({ city: "San Juan" })],
  }).decisions[0]!;
  assert.equal(cityMismatch.status, "REVIEW_REQUIRED");
  assert.ok(cityMismatch.reasons.includes("CITY_MISMATCH"));

  const countryMismatch = matchAirbnbPropertyPortfolio({
    properties: [property()],
    listings: [listing({ countryCode: "US" })],
  }).decisions[0]!;
  assert.equal(countryMismatch.status, "REVIEW_REQUIRED");
  assert.ok(countryMismatch.reasons.includes("COUNTRY_MISMATCH"));
});

test("listing details corroborate Las Piedras vs Collores with postal code and person capacity", () => {
  const pinGoProperty = property({ city: "Las Piedras", postalCode: "00771", maxGuests: 2 });
  const candidate = listing({ city: "Collores", occupancies: [1, 2, 3, 4] });
  const initial = matchAirbnbPropertyPortfolio({
    properties: [pinGoProperty],
    listings: [candidate],
  }).decisions[0]!;

  assert.equal(initial.status, "REVIEW_REQUIRED");
  const corroborated = corroborateAirbnbPropertyMatch({
    property: pinGoProperty,
    listing: candidate,
    decision: initial,
    details: {
      listingId: candidate.id,
      personCapacity: 2,
      city: "Collores",
      state: "Puerto Rico",
      postalCode: "00771",
      countryCode: "PR",
      latitude: 18.19,
      longitude: -65.87,
    },
  });

  assert.equal(corroborated.status, "AUTO_MATCH");
  assert.equal(corroborated.confidence, "HIGH");
  assert.ok(corroborated.reasons.includes("POSTAL_CODE_MATCH"));
  assert.ok(corroborated.reasons.includes("PERSON_CAPACITY_MATCH"));
  assert.ok(corroborated.reasons.includes("CITY_MISMATCH_CORROBORATED"));
});

test("postal or exact person-capacity contradictions remain review required", () => {
  const pinGoProperty = property({ city: "Las Piedras" });
  const candidate = listing({ city: "Collores" });
  const initial = matchAirbnbPropertyPortfolio({
    properties: [pinGoProperty],
    listings: [candidate],
  }).decisions[0]!;

  const postalMismatch = corroborateAirbnbPropertyMatch({
    property: pinGoProperty,
    listing: candidate,
    decision: initial,
    details: {
      listingId: candidate.id,
      personCapacity: 2,
      city: "Collores",
      state: "Puerto Rico",
      postalCode: "00901",
      countryCode: "PR",
      latitude: null,
      longitude: null,
    },
  });
  assert.equal(postalMismatch.status, "REVIEW_REQUIRED");
  assert.ok(postalMismatch.reasons.includes("POSTAL_CODE_MISMATCH"));

  const capacityMismatch = corroborateAirbnbPropertyMatch({
    property: pinGoProperty,
    listing: candidate,
    decision: initial,
    details: {
      listingId: candidate.id,
      personCapacity: 3,
      city: "Collores",
      state: "Puerto Rico",
      postalCode: "00771",
      countryCode: "PR",
      latitude: null,
      longitude: null,
    },
  });
  assert.equal(capacityMismatch.status, "REVIEW_REQUIRED");
  assert.ok(capacityMismatch.reasons.includes("PERSON_CAPACITY_MISMATCH"));
});

test("a close runner-up prevents an automatic match and details corroboration", () => {
  const pinGoProperty = property({ city: "Las Piedras" });
  const candidates = [
    listing({ id: "551126434553599406", city: "Collores" }),
    listing({ id: "551126434553599407", city: "Collores" }),
  ];
  const initial = matchAirbnbPropertyPortfolio({
    properties: [pinGoProperty],
    listings: candidates,
  }).decisions[0]!;

  assert.equal(initial.status, "REVIEW_REQUIRED");
  assert.ok(initial.reasons.includes("AMBIGUOUS_RUNNER_UP"));
  const corroborated = corroborateAirbnbPropertyMatch({
    property: pinGoProperty,
    listing: candidates[0]!,
    decision: initial,
    details: {
      listingId: candidates[0]!.id,
      personCapacity: 2,
      city: "Collores",
      state: "Puerto Rico",
      postalCode: "00771",
      countryCode: "PR",
      latitude: null,
      longitude: null,
    },
  });
  assert.equal(corroborated.status, "REVIEW_REQUIRED");
});

test("weak candidates remain unmatched", () => {
  const result = matchAirbnbPropertyPortfolio({
    properties: [property()],
    listings: [
      listing({
        id: "551126434553599499",
        title: "Ocean View Apartment",
        city: "San Juan",
        countryCode: "PR",
        occupancies: [1, 2, 3, 4],
      }),
    ],
  });

  assert.equal(result.decisions[0]?.status, "UNMATCHED");
  assert.equal(result.decisions[0]?.candidateListingId, null);
  assert.equal(result.summary.unmatched, 1);
});

test("one Airbnb listing can never be eligible for two Pin&Go properties", () => {
  const result = matchAirbnbPropertyPortfolio({
    properties: [
      property({ id: "property-1", city: "Las Piedras" }),
      property({ id: "property-2", city: "Las Piedras" }),
    ],
    listings: [listing({ city: "Collores" })],
  });

  assert.equal(result.summary.autoMatched, 0);
  assert.equal(result.summary.reviewRequired, 2);
  for (const decision of result.decisions) {
    assert.equal(decision.status, "REVIEW_REQUIRED");
    assert.ok(decision.reasons.includes("LISTING_CONFLICT"));
  }
});

test("uses whichever Pin&Go title is the stronger identity signal", () => {
  const result = matchAirbnbPropertyPortfolio({
    properties: [
      property({
        name: "Casa Collores",
        publicTitle: "Mountain Escape by Pin&Go",
      }),
    ],
    listings: [listing()],
  });

  assert.equal(result.decisions[0]?.status, "AUTO_MATCH");
  assert.equal(result.decisions[0]?.score, 95);
});
''')

Path("src/distribution/channex-airbnb-listings.transport.test.ts").write_text(r'''import assert from "node:assert/strict";
import test from "node:test";

import {
  AirbnbListingDiscoveryTransportError,
  createAirbnbListingDiscoveryHttpTransport,
} from "./airbnb-host-self-service.listings.http-transport.js";

const CHANNEL_ID = "44444444-4444-4444-8444-444444444444";
const LISTING_ID = "42544559";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Airbnb listing discovery uses the documented channel-scoped GET with no body", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const documentedPayload = {
    data: {
      listing_id_dictionary: {
        values: [
          {
            id: LISTING_ID,
            title: "Test Property · Test Channex Property",
            type: "apartment",
            occupancies: [1, 2, 3, 4],
            synchronization_category: "text",
            city: "text",
            country_code: "DE",
            quality_status: "text",
          },
        ],
      },
    },
  };
  const transport = createAirbnbListingDiscoveryHttpTransport({
    apiOrigin: "https://app.channex.io",
    apiKey: "secret",
    timeoutMs: 1000,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return response(documentedPayload);
    },
  });

  const result = await transport.listAirbnbListings(CHANNEL_ID);

  assert.deepEqual(result, documentedPayload);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://app.channex.io/api/v1/channels/${CHANNEL_ID}/action/listings`
  );
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(
    (calls[0].init?.headers as Record<string, string>)["user-api-key"],
    "secret"
  );
  assert.equal("body" in (calls[0].init ?? {}), false);
});

test("Airbnb listing details uses the documented listing_details GET and query parameter", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const documentedPayload = {
    data: {
      listing: {
        id: 42544559,
        id_str: LISTING_ID,
        person_capacity: 4,
        city: "Berlin",
        state: "Berlin",
        zipcode: "10115",
        country_code: "DE",
        lat: 52.520008,
        lng: 13.404954,
      },
    },
  };
  const transport = createAirbnbListingDiscoveryHttpTransport({
    apiOrigin: "https://app.channex.io",
    apiKey: "secret",
    timeoutMs: 1000,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return response(documentedPayload);
    },
  });

  const result = await transport.getAirbnbListingDetails(CHANNEL_ID, LISTING_ID);
  assert.deepEqual(result, documentedPayload);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://app.channex.io/api/v1/channels/${CHANNEL_ID}/action/listing_details?listing_id=${LISTING_ID}`
  );
  assert.equal(calls[0].init?.method, "GET");
  assert.equal("body" in (calls[0].init ?? {}), false);
});

test("Airbnb listing discovery rejects unsafe identifiers before provider access", async () => {
  let calls = 0;
  const transport = createAirbnbListingDiscoveryHttpTransport({
    apiOrigin: "https://app.channex.io",
    apiKey: "secret",
    timeoutMs: 1000,
    fetchImpl: async () => {
      calls += 1;
      return response({});
    },
  });

  await assert.rejects(
    transport.listAirbnbListings("../secrets"),
    (error: unknown) =>
      error instanceof AirbnbListingDiscoveryTransportError &&
      error.code === "OTA_AIRBNB_CHANNEL_ID_INVALID"
  );
  await assert.rejects(
    transport.getAirbnbListingDetails(CHANNEL_ID, "../secrets"),
    (error: unknown) =>
      error instanceof AirbnbListingDiscoveryTransportError &&
      error.code === "OTA_AIRBNB_LISTING_ID_INVALID"
  );
  assert.equal(calls, 0);
});

test("Airbnb listing reads map documented provider failures without retrying", async () => {
  for (const [status, code] of [
    [404, "OTA_AIRBNB_LISTING_DISCOVERY_NOT_FOUND"],
    [429, "OTA_AIRBNB_LISTING_DISCOVERY_RATE_LIMITED"],
    [422, "OTA_AIRBNB_LISTING_DISCOVERY_REQUEST_REJECTED"],
    [503, "OTA_AIRBNB_LISTING_DISCOVERY_PROVIDER_UNAVAILABLE"],
  ] as const) {
    let calls = 0;
    const transport = createAirbnbListingDiscoveryHttpTransport({
      apiOrigin: "https://app.channex.io",
      apiKey: "secret",
      timeoutMs: 1000,
      fetchImpl: async () => {
        calls += 1;
        return response({}, status);
      },
    });
    await assert.rejects(
      transport.getAirbnbListingDetails(CHANNEL_ID, LISTING_ID),
      (error: unknown) =>
        error instanceof AirbnbListingDiscoveryTransportError &&
        error.code === code
    );
    assert.equal(calls, 1);
  }
});
''')

Path("src/distribution/airbnb-host-self-service.listings.service.test.ts").write_text(r'''import assert from "node:assert/strict";
import test from "node:test";

import { AirbnbHostSelfServiceError } from "./airbnb-host-self-service.service.js";
import {
  discoverAirbnbListings,
  parseAirbnbListingDetailsPayload,
  parseAirbnbListingDiscoveryPayload,
} from "./airbnb-host-self-service.listings.service.js";

const CHANNEL_ID = "44444444-4444-4444-8444-444444444444";
const LISTING_ID = "42544559";

const DOCUMENTED_LISTINGS_PAYLOAD = {
  data: {
    listing_id_dictionary: {
      values: [
        {
          id: LISTING_ID,
          title: "Test Property · Test Channex Property",
          type: "apartment",
          occupancies: [1, 2, 3, 4],
          synchronization_category: "text",
          city: "text",
          country_code: "DE",
          quality_status: "text",
        },
      ],
    },
  },
};

const DOCUMENTED_DETAILS_PAYLOAD = {
  data: {
    listing: {
      id: 42544559,
      id_str: LISTING_ID,
      person_capacity: 4,
      city: "Berlin",
      state: "Berlin",
      zipcode: "10115",
      country_code: "DE",
      lat: 52.520008,
      lng: 13.404954,
    },
  },
};

const DEFAULT_CONNECTION = {
  organizationId: "org-1",
  propertyId: "property-1",
  provider: "AIRBNB",
  externalConnectionId: CHANNEL_ID,
};

const DEFAULT_PROPERTIES = [
  {
    id: "property-1",
    name: "Test Property · Test Channex Property",
    publicTitle: null,
    city: "text",
    country: "DE",
    postalCode: "10115",
    maxGuests: 4,
  },
];

function client(args: {
  connection?: any;
  properties?: any[];
} = {}) {
  const connectionQueries: unknown[] = [];
  const propertyQueries: unknown[] = [];
  const connection = Object.prototype.hasOwnProperty.call(args, "connection")
    ? args.connection
    : DEFAULT_CONNECTION;
  const properties = args.properties ?? DEFAULT_PROPERTIES;
  return {
    connectionQueries,
    propertyQueries,
    value: {
      otaChannelConnection: {
        async findFirst(query: unknown) {
          connectionQueries.push(query);
          return connection;
        },
      },
      property: {
        async findMany(query: unknown) {
          propertyQueries.push(query);
          return properties;
        },
      },
    },
  };
}

function transport(args: {
  listings?: unknown;
  details?: unknown;
  listingCalls?: string[];
  detailCalls?: Array<[string, string]>;
} = {}) {
  return {
    async listAirbnbListings(channelId: string) {
      args.listingCalls?.push(channelId);
      return args.listings ?? DOCUMENTED_LISTINGS_PAYLOAD;
    },
    async getAirbnbListingDetails(channelId: string, listingId: string) {
      args.detailCalls?.push([channelId, listingId]);
      return args.details ?? DOCUMENTED_DETAILS_PAYLOAD;
    },
  };
}

test("parses the documented Airbnb listing dictionary without adding provider fields", () => {
  assert.deepEqual(parseAirbnbListingDiscoveryPayload(DOCUMENTED_LISTINGS_PAYLOAD), [
    {
      id: LISTING_ID,
      title: "Test Property · Test Channex Property",
      type: "apartment",
      occupancies: [1, 2, 3, 4],
      synchronizationCategory: "text",
      city: "text",
      countryCode: "DE",
      qualityStatus: "text",
    },
  ]);
});

test("parses documented listing_details location and exact person capacity", () => {
  assert.deepEqual(parseAirbnbListingDetailsPayload(DOCUMENTED_DETAILS_PAYLOAD), {
    listingId: LISTING_ID,
    personCapacity: 4,
    city: "Berlin",
    state: "Berlin",
    postalCode: "10115",
    countryCode: "DE",
    latitude: 52.520008,
    longitude: 13.404954,
  });
});

test("discovers once from the persisted Airbnb channel and matches tenant properties locally", async () => {
  const db = client();
  const listingCalls: string[] = [];
  const detailCalls: Array<[string, string]> = [];
  const result = await discoverAirbnbListings({
    client: db.value,
    transport: transport({ listingCalls, detailCalls }),
    organizationId: "org-1",
    propertyId: "property-1",
  });

  assert.deepEqual(db.connectionQueries, [
    {
      where: {
        organizationId: "org-1",
        propertyId: "property-1",
        provider: "AIRBNB",
      },
      select: {
        organizationId: true,
        propertyId: true,
        provider: true,
        externalConnectionId: true,
      },
    },
  ]);
  assert.deepEqual(db.propertyQueries, [
    {
      where: {
        organizationId: "org-1",
        status: "ACTIVE",
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        name: true,
        publicTitle: true,
        city: true,
        country: true,
        postalCode: true,
        maxGuests: true,
      },
    },
  ]);
  assert.deepEqual(listingCalls, [CHANNEL_ID]);
  assert.deepEqual(detailCalls, []);
  assert.equal(result.channelId, CHANNEL_ID);
  assert.equal(result.listings[0]?.id, LISTING_ID);
  assert.equal(result.match.status, "AUTO_MATCH");
});

test("Casa Collores uses one documented detail read to corroborate Las Piedras vs Collores", async () => {
  const listingCalls: string[] = [];
  const detailCalls: Array<[string, string]> = [];
  const listings = {
    data: {
      listing_id_dictionary: {
        values: [
          {
            id: "551126434553599406",
            title: "Casa Collores",
            occupancies: [1, 2, 3, 4],
            city: "Collores",
            country_code: "PR",
          },
        ],
      },
    },
  };
  const details = {
    data: {
      listing: {
        id: 551126434553599406,
        id_str: "551126434553599406",
        person_capacity: 2,
        city: "Collores",
        state: "Puerto Rico",
        zipcode: "00771",
        country_code: "PR",
        lat: 18.19,
        lng: -65.87,
      },
    },
  };
  const db = client({
    properties: [
      {
        id: "property-1",
        name: "Casa Collores",
        publicTitle: null,
        city: "Las Piedras",
        country: "Puerto Rico",
        postalCode: "00771",
        maxGuests: 2,
      },
    ],
  });

  const result = await discoverAirbnbListings({
    client: db.value,
    transport: transport({ listings, details, listingCalls, detailCalls }),
    organizationId: "org-1",
    propertyId: "property-1",
  });

  assert.deepEqual(listingCalls, [CHANNEL_ID]);
  assert.deepEqual(detailCalls, [[CHANNEL_ID, "551126434553599406"]]);
  assert.equal(result.match.status, "AUTO_MATCH");
  assert.ok(result.match.reasons.includes("POSTAL_CODE_MATCH"));
  assert.ok(result.match.reasons.includes("PERSON_CAPACITY_MATCH"));
});

test("detail corroboration failure remains review required instead of forcing a match", async () => {
  const listings = {
    data: {
      listing_id_dictionary: {
        values: [
          {
            id: LISTING_ID,
            title: "Test Property · Test Channex Property",
            city: "Other locality",
            country_code: "DE",
          },
        ],
      },
    },
  };
  const result = await discoverAirbnbListings({
    client: client().value,
    transport: {
      async listAirbnbListings() {
        return listings;
      },
      async getAirbnbListingDetails() {
        throw new Error("provider unavailable");
      },
    },
    organizationId: "org-1",
    propertyId: "property-1",
  });

  assert.equal(result.match.status, "REVIEW_REQUIRED");
  assert.ok(result.match.reasons.includes("DETAILS_UNAVAILABLE"));
});

test("portfolio conflict detection prevents extra provider detail reads", async () => {
  const db = client({
    properties: [
      { ...DEFAULT_PROPERTIES[0], city: "other" },
      { ...DEFAULT_PROPERTIES[0], id: "property-2", city: "other" },
    ],
  });
  const detailCalls: Array<[string, string]> = [];
  const result = await discoverAirbnbListings({
    client: db.value,
    transport: transport({ detailCalls }),
    organizationId: "org-1",
    propertyId: "property-1",
  });

  assert.equal(result.match.status, "REVIEW_REQUIRED");
  assert.ok(result.match.reasons.includes("LISTING_CONFLICT"));
  assert.deepEqual(detailCalls, []);
});

test("fails closed before provider access when local connection scope does not match", async () => {
  for (const connection of [
    null,
    {
      organizationId: "org-other",
      propertyId: "property-1",
      provider: "AIRBNB",
      externalConnectionId: CHANNEL_ID,
    },
    {
      organizationId: "org-1",
      propertyId: "property-other",
      provider: "AIRBNB",
      externalConnectionId: CHANNEL_ID,
    },
    {
      organizationId: "org-1",
      propertyId: "property-1",
      provider: "BOOKING_COM",
      externalConnectionId: CHANNEL_ID,
    },
    {
      organizationId: "org-1",
      propertyId: "property-1",
      provider: "AIRBNB",
      externalConnectionId: null,
    },
  ]) {
    let providerCalls = 0;
    await assert.rejects(
      discoverAirbnbListings({
        client: client({ connection }).value,
        transport: {
          async listAirbnbListings() {
            providerCalls += 1;
            return DOCUMENTED_LISTINGS_PAYLOAD;
          },
          async getAirbnbListingDetails() {
            providerCalls += 1;
            return DOCUMENTED_DETAILS_PAYLOAD;
          },
        },
        organizationId: "org-1",
        propertyId: "property-1",
      }),
      (error: unknown) => error instanceof AirbnbHostSelfServiceError
    );
    assert.equal(providerCalls, 0);
  }
});

test("fails closed before provider access when the requested Pin&Go property is not active", async () => {
  let providerCalls = 0;
  await assert.rejects(
    discoverAirbnbListings({
      client: client({
        properties: [
          {
            id: "property-other",
            name: "Other",
            publicTitle: null,
            city: null,
            country: null,
            postalCode: null,
            maxGuests: null,
          },
        ],
      }).value,
      transport: {
        async listAirbnbListings() {
          providerCalls += 1;
          return DOCUMENTED_LISTINGS_PAYLOAD;
        },
        async getAirbnbListingDetails() {
          providerCalls += 1;
          return DOCUMENTED_DETAILS_PAYLOAD;
        },
      },
      organizationId: "org-1",
      propertyId: "property-1",
    }),
    (error: unknown) =>
      error instanceof AirbnbHostSelfServiceError &&
      error.code === "OTA_AIRBNB_PROPERTY_NOT_FOUND"
  );
  assert.equal(providerCalls, 0);
});

test("rejects malformed listing envelopes and details without inventing fields", () => {
  for (const payload of [
    null,
    {},
    { data: null },
    { data: {} },
    { data: { listing_id_dictionary: null } },
    { data: { listing_id_dictionary: {} } },
    { data: { listing_id_dictionary: { values: [null] } } },
    { data: { listing_id_dictionary: { values: [{ title: "Missing id" }] } } },
    { data: { listing_id_dictionary: { values: [{ id: "1", occupancies: [1, "2"] }] } } },
  ]) {
    assert.throws(
      () => parseAirbnbListingDiscoveryPayload(payload),
      (error: unknown) =>
        error instanceof AirbnbHostSelfServiceError &&
        error.code === "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
    );
  }

  for (const payload of [
    null,
    {},
    { data: {} },
    { data: { listing: null } },
    { data: { listing: { id: 1 } } },
    { data: { listing: { id_str: "1", person_capacity: "2" } } },
  ]) {
    assert.throws(
      () => parseAirbnbListingDetailsPayload(payload),
      (error: unknown) =>
        error instanceof AirbnbHostSelfServiceError &&
        error.code === "OTA_AIRBNB_LISTING_DISCOVERY_RESPONSE_INVALID"
    );
  }
});
''')

Path(".github/workflows/ota-airbnb-listing-discovery.yml").write_text(r'''name: OTA Airbnb Listing Discovery + Auto-Matching V1.1 Certification

on:
  pull_request:
    paths:
      - 'prisma/schema.prisma'
      - 'prisma/migrations/20260911153000_add_property_postal_code/migration.sql'
      - 'src/routes/properties.route.ts'
      - 'src/routes/dashboard.properties.route.ts'
      - 'src/distribution/airbnb-host-self-service.listings.http-transport.ts'
      - 'src/distribution/airbnb-host-self-service.listings.service.ts'
      - 'src/distribution/airbnb-host-self-service.listings.service.test.ts'
      - 'src/distribution/airbnb-property-auto-matching.ts'
      - 'src/distribution/airbnb-property-auto-matching.test.ts'
      - 'src/distribution/channex-airbnb-listings.transport.test.ts'
      - 'src/distribution/ota-connection-center.runtime-composition.ts'
      - 'src/distribution/ota-connection-center.runtime-composition.test.ts'
      - 'src/routes/dashboard.airbnb-host-self-service.route.ts'
      - 'src/routes/dashboard.airbnb-host-self-service.listings.route.test.ts'
      - '.github/workflows/ota-airbnb-listing-discovery.yml'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  listing-discovery-auto-matching-certification:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    env:
      DATABASE_URL: postgresql://user:pass@localhost:5432/pingo_test
    steps:
      - name: Checkout exact candidate
        uses: actions/checkout@v4
        with:
          persist-credentials: false
          fetch-depth: 0

      - name: Use Node.js 22
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm

      - name: Install locked dependencies
        run: npm ci --ignore-scripts --no-audit --no-fund

      - name: Generate and validate Prisma client
        run: |
          npx prisma generate
          npx prisma validate --schema ./prisma/schema.prisma

      - name: Prove exact narrow diff allowlist
        shell: bash
        run: |
          git fetch origin main --depth=1
          git diff --name-only origin/main...HEAD | sort > "$RUNNER_TEMP/actual.txt"
          cat > "$RUNNER_TEMP/expected.txt" <<'EOF'
          .github/workflows/ota-airbnb-listing-discovery.yml
          prisma/migrations/20260911153000_add_property_postal_code/migration.sql
          prisma/schema.prisma
          src/distribution/airbnb-host-self-service.listings.http-transport.ts
          src/distribution/airbnb-host-self-service.listings.service.test.ts
          src/distribution/airbnb-host-self-service.listings.service.ts
          src/distribution/airbnb-property-auto-matching.test.ts
          src/distribution/airbnb-property-auto-matching.ts
          src/distribution/channex-airbnb-listings.transport.test.ts
          src/routes/dashboard.properties.route.ts
          src/routes/properties.route.ts
          EOF
          sort "$RUNNER_TEMP/expected.txt" -o "$RUNNER_TEMP/expected.txt"
          diff -u "$RUNNER_TEMP/expected.txt" "$RUNNER_TEMP/actual.txt"

      - name: Prove certified write-capable Channex core remains frozen
        run: |
          git diff --exit-code origin/main...HEAD -- \
            src/pms \
            src/workers \
            src/distribution/channex-channel-identity.ts \
            src/distribution/channex-readonly.http-transport.ts \
            src/distribution/channex-white-label.http-transport.ts \
            src/distribution/channex-canonical-readiness.service.ts \
            src/distribution/channex-channel-lifecycle.evidence.ts \
            src/distribution/channex-airbnb-transport-readiness.policy.ts

      - name: Prove scope is read-only listing discovery and details corroboration only
        shell: bash
        run: |
          ! grep -R -E '/mappings|/activate|load_future_reservations|check_readiness' \
            src/distribution/airbnb-host-self-service.listings.http-transport.ts \
            src/distribution/airbnb-host-self-service.listings.service.ts \
            src/distribution/airbnb-property-auto-matching.ts
          grep -F '/action/listings' src/distribution/airbnb-host-self-service.listings.http-transport.ts
          grep -F '/action/listing_details' src/distribution/airbnb-host-self-service.listings.http-transport.ts
          grep -F 'person_capacity' src/distribution/airbnb-host-self-service.listings.service.ts
          grep -F 'zipcode' src/distribution/airbnb-host-self-service.listings.service.ts
          grep -F 'postalCode' prisma/schema.prisma

      - name: Type-check isolated listing and matching modules
        run: |
          ./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --types node \
            src/distribution/airbnb-host-self-service.listings.http-transport.ts \
            src/distribution/airbnb-property-auto-matching.ts \
            src/distribution/airbnb-host-self-service.listings.service.ts

      - name: Run V1.1 and retained Airbnb regressions
        run: |
          node --import tsx --test \
            src/distribution/airbnb-property-auto-matching.test.ts \
            src/distribution/channex-airbnb-listings.transport.test.ts \
            src/distribution/airbnb-host-self-service.listings.service.test.ts \
            src/routes/dashboard.airbnb-host-self-service.listings.route.test.ts \
            src/distribution/ota-connection-center.runtime-composition.test.ts \
            src/distribution/airbnb-host-self-service.service.test.ts \
            src/distribution/airbnb-host-self-service.callback-verifier.test.ts \
            src/distribution/airbnb-host-self-service.callback-persistence.test.ts
''')

print("patch staged")
