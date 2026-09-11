export type AirbnbPropertyMatchStatus =
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
  maxGuests: number | null;
};

export type AirbnbListingMatchInput = {
  id: string;
  title: string | null;
  city: string | null;
  countryCode: string | null;
  occupancies: number[] | null;
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
  maxGuestsMismatch: boolean;
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

  const listingMaxGuests = listing.occupancies?.length
    ? Math.max(...listing.occupancies)
    : null;
  const maxGuestsKnown = property.maxGuests != null && listingMaxGuests != null;
  const maxGuestsMismatch =
    maxGuestsKnown && property.maxGuests !== listingMaxGuests;
  if (maxGuestsKnown && !maxGuestsMismatch) {
    score += 5;
    reasons.push("MAX_GUESTS_MATCH");
  } else if (maxGuestsMismatch) {
    reasons.push("MAX_GUESTS_MISMATCH");
  } else {
    reasons.push("MAX_GUESTS_UNKNOWN");
  }

  return {
    listing,
    score: roundScore(score),
    nameSimilarity,
    cityMismatch,
    countryMismatch,
    maxGuestsMismatch,
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
    !top.maxGuestsMismatch &&
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

export function matchAirbnbPropertyPortfolio(args: {
  properties: readonly PinGoPropertyMatchInput[];
  listings: readonly AirbnbListingMatchInput[];
}): AirbnbPropertyPortfolioMatch {
  const decisions = args.properties.map((property) =>
    decideProperty(property, args.listings)
  );

  const autoByListing = new Map<string, number[]>();
  decisions.forEach((decision, index) => {
    if (decision.status !== "AUTO_MATCH" || !decision.candidateListingId) return;
    const indexes = autoByListing.get(decision.candidateListingId) ?? [];
    indexes.push(index);
    autoByListing.set(decision.candidateListingId, indexes);
  });

  for (const indexes of autoByListing.values()) {
    if (indexes.length < 2) continue;
    for (const index of indexes) {
      const decision = decisions[index]!;
      decisions[index] = {
        ...decision,
        status: "REVIEW_REQUIRED",
        confidence: "MEDIUM",
        reasons: [...decision.reasons, "LISTING_CONFLICT"],
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
