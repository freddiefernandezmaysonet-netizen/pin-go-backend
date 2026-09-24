import { PrismaClient } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";
import { checkPropertyAvailability } from "./availability.service";
import { calculateDirectBookingPricing } from "./direct-booking-pricing.service";

const prisma = new PrismaClient();

export const PUBLIC_STAY_SORTS = [
  "RECOMMENDED",
  "PRICE_LOW",
  "PRICE_HIGH",
  "RATING",
  "REVIEW_COUNT",
] as const;

export type PublicStaySort = (typeof PUBLIC_STAY_SORTS)[number];

export type PublicStaySearchInput = {
  destination: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  minTotalPrice?: number | null;
  maxTotalPrice?: number | null;
  currency?: string | null;
  minRating?: number | null;
  minReviewCount?: number | null;
  amenities?: string[] | null;
  accommodationTypes?: string[] | null;
  propertyTypes?: string[] | null;
  features?: string[] | null;
  bedTypes?: string[] | null;
  minBedrooms?: number | null;
  minBathrooms?: number | null;
  sort?: PublicStaySort | null;
  page?: number | null;
  pageSize?: number | null;
};

export type PublicStayPricingSummary = {
  currency: string;
  nights: number;
  nightlySubtotal: number;
  cleaningFee: number;
  amenitiesTotal: number;
  taxesTotal: number;
  totalAmount: number;
};

export type PublicStaySearchResult = {
  organizationSlug: string;
  propertySlug: string;
  title: string;
  city: string | null;
  region: string | null;
  country: string | null;
  maxGuests: number | null;
  minimumNights: number;
  maximumNights: number | null;
  photoUrl: string | null;
  bookingPath: string;
  averageRating: number | null;
  reviewCount: number;
  amenities: string[];
  matchedAmenities: string[];
  listingDetails: {
    accommodationType: "ENTIRE_PLACE" | "PRIVATE_ROOM" | "SHARED_ROOM" | null;
    propertyType: "HOUSE" | "APARTMENT" | "CONDO" | "CABIN" | "COTTAGE" | "VILLA" | "TOWNHOUSE" | "BUNGALOW" | "LOFT" | "STUDIO" | "GUESTHOUSE" | "FARM_STAY" | "OTHER" | null;
    bedroomCount: number | null;
    fullBathroomCount: number | null;
    halfBathroomCount: number | null;
    bedTypes: string[];
    features: string[];
  } | null;
  pricing: PublicStayPricingSummary;
};

type ValidatedPublicStaySearchInput = {
  destination: string;
  checkInKey: string;
  checkOutKey: string;
  guests: number;
  stayNights: number;
  minTotalPrice: number | null;
  maxTotalPrice: number | null;
  currency: "USD";
  minRating: number | null;
  minReviewCount: number;
  amenities: string[];
  accommodationTypes: Array<"ENTIRE_PLACE" | "PRIVATE_ROOM" | "SHARED_ROOM">;
  propertyTypes: Array<"HOUSE" | "APARTMENT" | "CONDO" | "CABIN" | "COTTAGE" | "VILLA" | "TOWNHOUSE" | "BUNGALOW" | "LOFT" | "STUDIO" | "GUESTHOUSE" | "FARM_STAY" | "OTHER">;
  features: Array<"WOOD_CONSTRUCTION" | "OCEAN_VIEW" | "MOUNTAIN_VIEW" | "WATERFRONT" | "BEACH_ACCESS" | "POOL_TABLE" | "GYM" | "FIREPLACE" | "OUTDOOR_GRILL" | "WORKSPACE" | "OTHER">;
  bedTypes: Array<"KING" | "QUEEN" | "DOUBLE" | "SINGLE" | "BUNK" | "SOFA_BED" | "FUTON" | "CRIB" | "OTHER">;
  minBedrooms: number | null;
  minBathrooms: number | null;
  sort: PublicStaySort;
  page: number;
  pageSize: number;
};

type SearchDependencies = {
  prismaClient?: PrismaClient;
  availabilityChecker?: typeof checkPropertyAvailability;
  pricingCalculator?: typeof calculateDirectBookingPricing;
};

const AMENITY_ALIASES: Record<string, string[]> = {
  wifi: ["wifi", "wi-fi", "wi fi", "wireless internet", "internet"],
  pool: ["pool", "swimming pool", "piscina"],
  parking: ["parking", "free parking", "estacionamiento", "aparcamiento"],
  gym: ["gym", "fitness center", "fitness centre", "gimnasio"],
  "pool table": ["pool table", "billiards", "billiard table", "mesa de billar", "billar"],
  "ocean view": ["ocean view", "sea view", "water view", "vista al mar", "vista al oceano"],
  "air conditioning": ["air conditioning", "a c", "ac", "aire acondicionado"],
  kitchen: ["kitchen", "cocina"],
  washer: ["washer", "washing machine", "lavadora"],
  dryer: ["dryer", "secadora"],
  "hot tub": ["hot tub", "jacuzzi", "spa"],
};

export function normalizePublicStaySearchText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function canonicalAmenityName(value: unknown) {
  const normalized = normalizePublicStaySearchText(value);
  if (!normalized) return "";

  for (const [canonical, aliases] of Object.entries(AMENITY_ALIASES)) {
    if (
      normalized === canonical ||
      aliases.some((alias) => normalizePublicStaySearchText(alias) === normalized)
    ) {
      return canonical;
    }
  }

  return normalized;
}

function normalizeRequestedAmenities(value: unknown) {
  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(
      value
        .map(canonicalAmenityName)
        .filter(Boolean)
        .slice(0, 25)
    )
  );
}

const ACCOMMODATION_TYPES = ["ENTIRE_PLACE", "PRIVATE_ROOM", "SHARED_ROOM"] as const;
const PROPERTY_TYPES = ["HOUSE", "APARTMENT", "CONDO", "CABIN", "COTTAGE", "VILLA", "TOWNHOUSE", "BUNGALOW", "LOFT", "STUDIO", "GUESTHOUSE", "FARM_STAY", "OTHER"] as const;
const FEATURE_TYPES = ["WOOD_CONSTRUCTION", "OCEAN_VIEW", "MOUNTAIN_VIEW", "WATERFRONT", "BEACH_ACCESS", "POOL_TABLE", "GYM", "FIREPLACE", "OUTDOOR_GRILL", "WORKSPACE", "OTHER"] as const;
const BED_TYPES = ["KING", "QUEEN", "DOUBLE", "SINGLE", "BUNK", "SOFA_BED", "FUTON", "CRIB", "OTHER"] as const;

function normalizeEnumList<T extends readonly string[]>(value: unknown, allowed: T): T[number][] | null {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const normalized = Array.from(new Set(value.map((item) => String(item).trim().toUpperCase()).filter(Boolean)));
  return normalized.every((item) => (allowed as readonly string[]).includes(item))
    ? (normalized as T[number][])
    : null;
}

function parseOptionalNonNegativeNumber(value: unknown) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function parsePublicStayDateKey(value: unknown) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return raw;
}

function parseOptionalMoney(value: unknown) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 100) / 100
    : null;
}

function parseOptionalRating(value: unknown) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 && number <= 5
    ? Math.round(number * 10) / 10
    : null;
}

function parseNonNegativeInteger(value: unknown, fallback: number) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function parsePositiveInteger(
  value: unknown,
  fallback: number,
  maximum: number
) {
  if (value == null || value === "") return fallback;
  const number = Number(value);

  return Number.isSafeInteger(number) && number >= 1 && number <= maximum
    ? number
    : null;
}

export function validatePublicStaySearchInput(
  input: PublicStaySearchInput
):
  | { ok: true; value: ValidatedPublicStaySearchInput }
  | { ok: false; code: string } {
  const destination = normalizePublicStaySearchText(input.destination);
  const checkInKey = parsePublicStayDateKey(input.checkIn);
  const checkOutKey = parsePublicStayDateKey(input.checkOut);
  const guests = Number(input.guests);

  if (!destination) {
    return { ok: false, code: "DESTINATION_REQUIRED" };
  }

  if (!checkInKey || !checkOutKey) {
    return { ok: false, code: "INVALID_STAY_DATES" };
  }

  if (!Number.isInteger(guests) || guests < 1 || guests > 20) {
    return { ok: false, code: "INVALID_GUEST_COUNT" };
  }

  const checkInDate = new Date(`${checkInKey}T00:00:00.000Z`);
  const checkOutDate = new Date(`${checkOutKey}T00:00:00.000Z`);
  const today = new Date();
  const todayKey = `${today.getUTCFullYear()}-${String(
    today.getUTCMonth() + 1
  ).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;

  if (checkInKey < todayKey) {
    return { ok: false, code: "CHECK_IN_IN_PAST" };
  }

  if (checkOutDate <= checkInDate) {
    return { ok: false, code: "CHECK_OUT_MUST_FOLLOW_CHECK_IN" };
  }

  const stayNights = Math.round(
    (checkOutDate.getTime() - checkInDate.getTime()) / 86_400_000
  );

  const minTotalPrice = parseOptionalMoney(input.minTotalPrice);
  const maxTotalPrice = parseOptionalMoney(input.maxTotalPrice);

  if (input.minTotalPrice != null && minTotalPrice === null) {
    return { ok: false, code: "INVALID_MIN_TOTAL_PRICE" };
  }

  if (input.maxTotalPrice != null && maxTotalPrice === null) {
    return { ok: false, code: "INVALID_MAX_TOTAL_PRICE" };
  }

  if (
    minTotalPrice !== null &&
    maxTotalPrice !== null &&
    minTotalPrice > maxTotalPrice
  ) {
    return { ok: false, code: "INVALID_TOTAL_PRICE_RANGE" };
  }

  const currency = String(input.currency ?? "USD").trim().toUpperCase();
  if (currency !== "USD") {
    return { ok: false, code: "UNSUPPORTED_CURRENCY" };
  }

  const minRating = parseOptionalRating(input.minRating);
  if (input.minRating != null && minRating === null) {
    return { ok: false, code: "INVALID_MIN_RATING" };
  }

  const minReviewCount = parseNonNegativeInteger(input.minReviewCount, 0);
  if (minReviewCount === null) {
    return { ok: false, code: "INVALID_MIN_REVIEW_COUNT" };
  }

  const accommodationTypes = normalizeEnumList(input.accommodationTypes, ACCOMMODATION_TYPES);
  if (accommodationTypes === null) {
    return { ok: false, code: "INVALID_ACCOMMODATION_TYPES" };
  }

  const propertyTypes = normalizeEnumList(input.propertyTypes, PROPERTY_TYPES);
  if (propertyTypes === null) {
    return { ok: false, code: "INVALID_PROPERTY_TYPES" };
  }

  const features = normalizeEnumList(input.features, FEATURE_TYPES);
  if (features === null) {
    return { ok: false, code: "INVALID_FEATURES" };
  }

  const bedTypes = normalizeEnumList(input.bedTypes, BED_TYPES);
  if (bedTypes === null) {
    return { ok: false, code: "INVALID_BED_TYPES" };
  }

  const minBedrooms = parseOptionalNonNegativeNumber(input.minBedrooms);
  if (input.minBedrooms != null && minBedrooms === null) {
    return { ok: false, code: "INVALID_MIN_BEDROOMS" };
  }

  const minBathrooms = parseOptionalNonNegativeNumber(input.minBathrooms);
  if (input.minBathrooms != null && minBathrooms === null) {
    return { ok: false, code: "INVALID_MIN_BATHROOMS" };
  }

  const sort = String(input.sort ?? "RECOMMENDED").trim().toUpperCase();
  if (!PUBLIC_STAY_SORTS.includes(sort as PublicStaySort)) {
    return { ok: false, code: "INVALID_SORT" };
  }

  const page = parsePositiveInteger(input.page, 1, 100_000);
  const pageSize = parsePositiveInteger(input.pageSize, 24, 50);

  if (page === null) {
    return { ok: false, code: "INVALID_PAGE" };
  }

  if (pageSize === null) {
    return { ok: false, code: "INVALID_PAGE_SIZE" };
  }

  return {
    ok: true,
    value: {
      destination,
      checkInKey,
      checkOutKey,
      guests,
      stayNights,
      minTotalPrice,
      maxTotalPrice,
      currency: "USD",
      minRating,
      minReviewCount,
      amenities: normalizeRequestedAmenities(input.amenities),
      accommodationTypes,
      propertyTypes,
      features,
      bedTypes,
      minBedrooms,
      minBathrooms,
      sort: sort as PublicStaySort,
      page,
      pageSize,
    },
  };
}

function getPhotoUrl(value: unknown) {
  return Array.isArray(value) && typeof value[0] === "string"
    ? value[0]
    : null;
}

function matchesDestination(
  property: {
    name: string;
    publicTitle?: string | null;
    city?: string | null;
    region?: string | null;
    country?: string | null;
  },
  destination: string
) {
  const haystack = normalizePublicStaySearchText(
    [
      property.publicTitle,
      property.name,
      property.city,
      property.region,
      property.country,
      [property.city, property.region].filter(Boolean).join(", "),
      [property.city, property.region, property.country]
        .filter(Boolean)
        .join(", "),
    ]
      .filter(Boolean)
      .join(" ")
  );

  return haystack.includes(destination);
}

function propertyAmenityCanonicalNames(
  amenities: Array<{ name: string; isActive?: boolean }>
) {
  return Array.from(
    new Set(
      amenities
        .filter((amenity) => amenity.isActive !== false)
        .map((amenity) => canonicalAmenityName(amenity.name))
        .filter(Boolean)
    )
  );
}

function matchesRequestedAmenities(
  amenities: Array<{ name: string; isActive?: boolean }>,
  requestedAmenities: string[]
) {
  if (!requestedAmenities.length) return true;
  const available = new Set(propertyAmenityCanonicalNames(amenities));
  return requestedAmenities.every((amenity) => available.has(amenity));
}

function selectedAmenityIdsForPricing(
  amenities: Array<{ id: string; name: string; isActive?: boolean }>,
  requestedAmenities: string[]
) {
  if (!requestedAmenities.length) return [];

  const requested = new Set(requestedAmenities);
  return amenities
    .filter(
      (amenity) =>
        amenity.isActive !== false &&
        requested.has(canonicalAmenityName(amenity.name))
    )
    .map((amenity) => amenity.id);
}

function buildPropertyStayDate(
  dateKey: string,
  time: string | null | undefined,
  timezone: string,
  fallbackTime: string
) {
  const safeTime = String(time ?? "").trim() || fallbackTime;
  return fromZonedTime(`${dateKey}T${safeTime}:00`, timezone);
}

function hasValidTimeZone(value: unknown) {
  const timezone = String(value ?? "").trim();
  if (!timezone) return false;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function compareNullableNumberDesc(
  a: number | null,
  b: number | null
) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function sortSearchResults(
  results: PublicStaySearchResult[],
  sort: PublicStaySort
) {
  return [...results].sort((a, b) => {
    if (sort === "PRICE_LOW") {
      return (
        a.pricing.totalAmount - b.pricing.totalAmount ||
        compareNullableNumberDesc(a.averageRating, b.averageRating) ||
        b.reviewCount - a.reviewCount ||
        a.title.localeCompare(b.title)
      );
    }

    if (sort === "PRICE_HIGH") {
      return (
        b.pricing.totalAmount - a.pricing.totalAmount ||
        compareNullableNumberDesc(a.averageRating, b.averageRating) ||
        b.reviewCount - a.reviewCount ||
        a.title.localeCompare(b.title)
      );
    }

    if (sort === "RATING") {
      return (
        compareNullableNumberDesc(a.averageRating, b.averageRating) ||
        b.reviewCount - a.reviewCount ||
        a.pricing.totalAmount - b.pricing.totalAmount ||
        a.title.localeCompare(b.title)
      );
    }

    if (sort === "REVIEW_COUNT") {
      return (
        b.reviewCount - a.reviewCount ||
        compareNullableNumberDesc(a.averageRating, b.averageRating) ||
        a.pricing.totalAmount - b.pricing.totalAmount ||
        a.title.localeCompare(b.title)
      );
    }

    return (
      compareNullableNumberDesc(a.averageRating, b.averageRating) ||
      b.reviewCount - a.reviewCount ||
      a.pricing.totalAmount - b.pricing.totalAmount ||
      a.title.localeCompare(b.title)
    );
  });
}

export async function searchPublicStays(
  input: PublicStaySearchInput,
  dependencies: SearchDependencies = {}
) {
  const validatedResult = validatePublicStaySearchInput(input);
  if (!validatedResult.ok) return validatedResult;

  const validated = validatedResult.value;
  const db = dependencies.prismaClient ?? prisma;
  const availabilityChecker =
    dependencies.availabilityChecker ?? checkPropertyAvailability;
  const pricingCalculator =
    dependencies.pricingCalculator ?? calculateDirectBookingPricing;

  const candidates = await db.property.findMany({
    where: {
      status: "ACTIVE",
      isPublicBookable: true,
      slug: { not: null },
      maxGuests: { gte: validated.guests },
      organization: {
        publicBookingEnabled: true,
        slug: { not: null },
      },
    },
    select: {
      id: true,
      name: true,
      slug: true,
      publicTitle: true,
      publicPhotos: true,
      maxGuests: true,
      minimumNights: true,
      maximumNights: true,
      city: true,
      region: true,
      country: true,
      timezone: true,
      checkInTime: true,
      checkOutTime: true,
      listingDetails: {
        select: {
          accommodationType: true,
          propertyType: true,
          bedroomCount: true,
          fullBathroomCount: true,
          halfBathroomCount: true,
          features: {
            where: { isActive: true },
            select: { type: true },
          },
          sleepingAreas: {
            select: {
              beds: {
                select: { type: true, quantity: true },
              },
            },
          },
        },
      },
      amenities: {
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          isActive: true,
          chargeMode: true,
        },
        orderBy: { name: "asc" },
      },
      organization: {
        select: { slug: true },
      },
    },
    take: 200,
  });

  const destinationMatches = candidates.filter((property) =>
    matchesDestination(property, validated.destination)
  );

  const amenityMatches = destinationMatches.filter((property) =>
    matchesRequestedAmenities(property.amenities, validated.amenities)
  );

  const listingMatches = amenityMatches.filter((property) => {
    const details = property.listingDetails;

    if (
      validated.accommodationTypes.length &&
      (!details?.accommodationType ||
        !validated.accommodationTypes.includes(details.accommodationType))
    ) {
      return false;
    }

    if (
      validated.propertyTypes.length &&
      (!details?.propertyType ||
        !validated.propertyTypes.includes(details.propertyType))
    ) {
      return false;
    }

    if (validated.features.length) {
      if (!details) return false;
      const availableFeatures = new Set(details.features.map((feature) => feature.type));
      if (!validated.features.every((feature) => availableFeatures.has(feature))) {
        return false;
      }
    }

    if (
      validated.minBedrooms !== null &&
      (details?.bedroomCount == null ||
        details.bedroomCount < validated.minBedrooms)
    ) {
      return false;
    }

    if (validated.minBathrooms !== null) {
      if (!details || details.fullBathroomCount == null) return false;
      const bathrooms =
        details.fullBathroomCount + (details.halfBathroomCount ?? 0) * 0.5;
      if (bathrooms < validated.minBathrooms) return false;
    }

    if (validated.bedTypes.length) {
      if (!details) return false;
      const availableBedTypes = new Set(
        details.sleepingAreas.flatMap((area) =>
          area.beds
            .filter((bed) => Number(bed.quantity) > 0)
            .map((bed) => bed.type)
        )
      );
      if (!validated.bedTypes.every((bedType) => availableBedTypes.has(bedType))) {
        return false;
      }
    }

    return true;
  });

  const stayRuleMatches = listingMatches.filter(
    (property) =>
      validated.stayNights >= property.minimumNights &&
      (property.maximumNights == null ||
        validated.stayNights <= property.maximumNights)
  );

  const availableProperties = (
    await Promise.all(
      stayRuleMatches.map(async (property) => {
        const timezone = String(property.timezone ?? "").trim();

        if (!hasValidTimeZone(timezone)) {
          console.warn(
            "[public-stay-search] skipping property with missing/invalid timezone",
            {
              propertyId: property.id,
              propertySlug: property.slug,
              timezone: timezone || null,
            }
          );
          return null;
        }

        const checkIn = buildPropertyStayDate(
          validated.checkInKey,
          property.checkInTime,
          timezone,
          "16:00"
        );
        const checkOut = buildPropertyStayDate(
          validated.checkOutKey,
          property.checkOutTime,
          timezone,
          "11:00"
        );
        const availability = await availabilityChecker({
          propertyId: property.id,
          checkIn,
          checkOut,
        });

        if (
          !availability.available ||
          !property.slug ||
          !property.organization.slug
        ) {
          return null;
        }

        return { property, checkIn, checkOut };
      })
    )
  ).filter(
    (
      value
    ): value is {
      property: (typeof stayRuleMatches)[number];
      checkIn: Date;
      checkOut: Date;
    } => value !== null
  );

  const availablePropertyIds = availableProperties.map(
    ({ property }) => property.id
  );

  const reviewGroups = availablePropertyIds.length
    ? await db.propertyReview.groupBy({
        by: ["propertyId"],
        where: {
          propertyId: { in: availablePropertyIds },
          status: "PUBLISHED",
          source: "PIN_GO_DIRECT",
        },
        _count: { _all: true },
        _avg: { overallRating: true },
      })
    : [];

  const reviewsByPropertyId = new Map(
    reviewGroups.map((group) => [
      group.propertyId,
      {
        reviewCount: group._count._all,
        averageRating:
          group._avg.overallRating == null
            ? null
            : Math.round(Number(group._avg.overallRating) * 10) / 10,
      },
    ])
  );

  const reviewMatches = availableProperties.filter(({ property }) => {
    const metrics = reviewsByPropertyId.get(property.id) ?? {
      reviewCount: 0,
      averageRating: null,
    };

    if (metrics.reviewCount < validated.minReviewCount) return false;

    if (
      validated.minRating !== null &&
      (metrics.averageRating === null ||
        metrics.averageRating < validated.minRating)
    ) {
      return false;
    }

    return true;
  });

  const pricedResults = (
    await Promise.all(
      reviewMatches.map(async ({ property, checkIn, checkOut }) => {
        const selectedAmenityIds = selectedAmenityIdsForPricing(
          property.amenities,
          validated.amenities
        );

        const pricing = await pricingCalculator({
          propertyId: property.id,
          checkIn,
          checkOut,
          selectedAmenityIds,
        });

        const totalAmount = Number(pricing.totalAmount);

        if (
          validated.minTotalPrice !== null &&
          totalAmount < validated.minTotalPrice
        ) {
          return null;
        }

        if (
          validated.maxTotalPrice !== null &&
          totalAmount > validated.maxTotalPrice
        ) {
          return null;
        }

        const reviewMetrics = reviewsByPropertyId.get(property.id) ?? {
          reviewCount: 0,
          averageRating: null,
        };
        const canonicalAmenities = propertyAmenityCanonicalNames(
          property.amenities
        );

        const result: PublicStaySearchResult = {
          organizationSlug: property.organization.slug!,
          propertySlug: property.slug!,
          title: property.publicTitle?.trim() || property.name,
          city: property.city ?? null,
          region: property.region ?? null,
          country: property.country ?? null,
          maxGuests: property.maxGuests ?? null,
          minimumNights: property.minimumNights,
          maximumNights: property.maximumNights ?? null,
          photoUrl: getPhotoUrl(property.publicPhotos),
          bookingPath: `/book/${property.organization.slug}/${property.slug}`,
          averageRating: reviewMetrics.averageRating,
          reviewCount: reviewMetrics.reviewCount,
          amenities: property.amenities.map((amenity) => amenity.name),
          matchedAmenities: validated.amenities.filter((amenity) =>
            canonicalAmenities.includes(amenity)
          ),
          listingDetails: property.listingDetails
            ? {
                accommodationType: property.listingDetails.accommodationType,
                propertyType: property.listingDetails.propertyType,
                bedroomCount: property.listingDetails.bedroomCount,
                fullBathroomCount: property.listingDetails.fullBathroomCount,
                halfBathroomCount: property.listingDetails.halfBathroomCount,
                features: property.listingDetails.features.map((feature) => feature.type),
                bedTypes: Array.from(
                  new Set(
                    property.listingDetails.sleepingAreas.flatMap((area) =>
                      area.beds
                        .filter((bed) => Number(bed.quantity) > 0)
                        .map((bed) => bed.type)
                    )
                  )
                ),
              }
            : null,
          pricing: {
            currency: String(pricing.currency ?? "usd").toUpperCase(),
            nights: Number(pricing.nights),
            nightlySubtotal: Number(pricing.nightlySubtotal),
            cleaningFee: Number(pricing.cleaningFee),
            amenitiesTotal: Number(pricing.amenitiesTotal),
            taxesTotal: Number(pricing.taxesTotal),
            totalAmount,
          },
        };

        return result;
      })
    )
  ).filter(
    (result): result is PublicStaySearchResult => result !== null
  );

  const sortedResults = sortSearchResults(pricedResults, validated.sort);
  const total = sortedResults.length;
  const offset = (validated.page - 1) * validated.pageSize;
  const pagedResults = sortedResults.slice(
    offset,
    offset + validated.pageSize
  );

  return {
    ok: true as const,
    query: {
      destination: input.destination.trim(),
      checkIn: validated.checkInKey,
      checkOut: validated.checkOutKey,
      guests: validated.guests,
      stayNights: validated.stayNights,
      minTotalPrice: validated.minTotalPrice,
      maxTotalPrice: validated.maxTotalPrice,
      currency: validated.currency,
      minRating: validated.minRating,
      minReviewCount: validated.minReviewCount,
      amenities: validated.amenities,
      accommodationTypes: validated.accommodationTypes,
      propertyTypes: validated.propertyTypes,
      features: validated.features,
      bedTypes: validated.bedTypes,
      minBedrooms: validated.minBedrooms,
      minBathrooms: validated.minBathrooms,
      sort: validated.sort,
      page: validated.page,
      pageSize: validated.pageSize,
    },
    pagination: {
      page: validated.page,
      pageSize: validated.pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / validated.pageSize),
    },
    results: pagedResults,
  };
}
