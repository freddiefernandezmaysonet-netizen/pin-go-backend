import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePublicStaySearchText,
  parsePublicStayDateKey,
  validatePublicStaySearchInput,
  searchPublicStays,
} from "./public-stay-search.service";

const FUTURE_STAY = {
  destination: "California",
  checkIn: "2099-10-10",
  checkOut: "2099-10-16",
  guests: 2,
};

test("normalizes case accents and whitespace", () => {
  assert.equal(normalizePublicStaySearchText("  ÍSA  "), "isa");
});

test("accepts valid date keys and rejects invalid calendar dates", () => {
  assert.equal(parsePublicStayDateKey("2026-10-10"), "2026-10-10");
  assert.equal(parsePublicStayDateKey("2026-02-30"), null);
});

test("requires checkout after checkin", () => {
  const result = validatePublicStaySearchInput({
    ...FUTURE_STAY,
    checkOut: FUTURE_STAY.checkIn,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "CHECK_OUT_MUST_FOLLOW_CHECK_IN");
  }
});

test("rejects invalid guest counts", () => {
  const result = validatePublicStaySearchInput({
    ...FUTURE_STAY,
    guests: 0,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "INVALID_GUEST_COUNT");
  }
});

test("accepts total-price, rating and review-count facets", () => {
  const result = validatePublicStaySearchInput({
    ...FUTURE_STAY,
    minTotalPrice: 750,
    maxTotalPrice: 1500,
    currency: "usd",
    minRating: 4,
    minReviewCount: 3,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.minTotalPrice, 750);
  assert.equal(result.value.maxTotalPrice, 1500);
  assert.equal(result.value.currency, "USD");
  assert.equal(result.value.minRating, 4);
  assert.equal(result.value.minReviewCount, 3);
});

test("rejects an inverted total-price range", () => {
  const result = validatePublicStaySearchInput({
    ...FUTURE_STAY,
    minTotalPrice: 1500,
    maxTotalPrice: 1000,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "INVALID_TOTAL_PRICE_RANGE");
  }
});

test("rejects unsupported search currency instead of silently converting it", () => {
  const result = validatePublicStaySearchInput({
    ...FUTURE_STAY,
    maxTotalPrice: 1500,
    currency: "EUR",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "UNSUPPORTED_CURRENCY");
  }
});

test("normalizes bilingual amenity aliases for canonical matching", () => {
  const result = validatePublicStaySearchInput({
    ...FUTURE_STAY,
    amenities: [
      "Mesa de billar",
      "Gimnasio",
      "Vista al mar",
      "Wi-Fi",
      "mesa de billar",
    ],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.value.amenities, [
    "pool table",
    "gym",
    "ocean view",
    "wifi",
  ]);
});

test("accepts deterministic sort and pagination controls", () => {
  const result = validatePublicStaySearchInput({
    ...FUTURE_STAY,
    sort: "PRICE_LOW",
    page: 2,
    pageSize: 12,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.sort, "PRICE_LOW");
  assert.equal(result.value.page, 2);
  assert.equal(result.value.pageSize, 12);
});

test("rejects unsupported sort values and oversized pages", () => {
  const invalidSort = validatePublicStaySearchInput({
    ...FUTURE_STAY,
    sort: "CHEAPEST" as never,
  });

  assert.equal(invalidSort.ok, false);
  if (!invalidSort.ok) {
    assert.equal(invalidSort.code, "INVALID_SORT");
  }

  const invalidPageSize = validatePublicStaySearchInput({
    ...FUTURE_STAY,
    pageSize: 51,
  });

  assert.equal(invalidPageSize.ok, false);
  if (!invalidPageSize.ok) {
    assert.equal(invalidPageSize.code, "INVALID_PAGE_SIZE");
  }
});


test("accepts canonical Listing Details facets for future Pin AI discovery", () => {
  const result = validatePublicStaySearchInput({
    ...FUTURE_STAY,
    accommodationTypes: ["entire_place"],
    bedTypes: ["king"],
    minBedrooms: 2,
    minBathrooms: 1.5,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.value.accommodationTypes, ["ENTIRE_PLACE"]);
  assert.deepEqual(result.value.bedTypes, ["KING"]);
  assert.equal(result.value.minBedrooms, 2);
  assert.equal(result.value.minBathrooms, 1.5);
});

test("rejects unknown accommodation and bed types instead of guessing", () => {
  const accommodation = validatePublicStaySearchInput({
    ...FUTURE_STAY,
    accommodationTypes: ["CABIN"],
  });

  assert.equal(accommodation.ok, false);
  if (!accommodation.ok) {
    assert.equal(accommodation.code, "INVALID_ACCOMMODATION_TYPES");
  }

  const bed = validatePublicStaySearchInput({
    ...FUTURE_STAY,
    bedTypes: ["CALIFORNIA_KING"],
  });

  assert.equal(bed.ok, false);
  if (!bed.ok) {
    assert.equal(bed.code, "INVALID_BED_TYPES");
  }
});


test("accepts physical property type independently from accommodation mode", () => {
  const result = validatePublicStaySearchInput({
    ...FUTURE_STAY,
    accommodationTypes: ["ENTIRE_PLACE"],
    propertyTypes: ["cabin"],
    bedTypes: ["KING"],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.value.accommodationTypes, ["ENTIRE_PLACE"]);
  assert.deepEqual(result.value.propertyTypes, ["CABIN"]);
  assert.deepEqual(result.value.bedTypes, ["KING"]);
});

test("rejects unknown physical property types instead of guessing", () => {
  const result = validatePublicStaySearchInput({
    ...FUTURE_STAY,
    propertyTypes: ["WOODEN_CABIN"],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "INVALID_PROPERTY_TYPES");
  }
});


test("accepts canonical listing features without inferring them from prose", () => {
  const result = validatePublicStaySearchInput({
    ...FUTURE_STAY,
    propertyTypes: ["CABIN"],
    features: ["wood_construction", "ocean_view", "pool_table", "gym"],
    bedTypes: ["KING"],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.value.propertyTypes, ["CABIN"]);
  assert.deepEqual(result.value.features, [
    "WOOD_CONSTRUCTION",
    "OCEAN_VIEW",
    "POOL_TABLE",
    "GYM",
  ]);
  assert.deepEqual(result.value.bedTypes, ["KING"]);
});

test("rejects unknown listing features instead of inventing a match", () => {
  const result = validatePublicStaySearchInput({
    ...FUTURE_STAY,
    features: ["ROMANTIC"],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "INVALID_FEATURES");
  }
});


test("candidate discovery paginates past 200 properties instead of silently truncating", async () => {
  const totalCandidates = 205;
  const allCandidates = Array.from({ length: totalCandidates }, (_, index) => ({
    id: `property-${String(index + 1).padStart(3, "0")}`,
    name: `California Stay ${index + 1}`,
    slug: `stay-${index + 1}`,
    publicTitle: null,
    publicPhotos: null,
    maxGuests: 4,
    minimumNights: 1,
    maximumNights: null,
    city: "Los Angeles",
    region: "California",
    country: "USA",
    timezone: "America/Los_Angeles",
    checkInTime: "16:00",
    checkOutTime: "11:00",
    listingDetails: null,
    amenities: [],
    organization: { slug: "test-org" },
  }));

  let candidateCalls = 0;
  const db = {
    property: {
      async findMany(args: any) {
        candidateCalls += 1;
        const cursorId = args.cursor?.id as string | undefined;
        const start = cursorId
          ? allCandidates.findIndex((item) => item.id === cursorId) + (args.skip ?? 0)
          : 0;
        return allCandidates.slice(start, start + args.take);
      },
    },
    propertyReview: {
      async groupBy() {
        return [];
      },
    },
  };

  const result = await searchPublicStays(
    {
      ...FUTURE_STAY,
      destination: "California",
      pageSize: 50,
    },
    {
      prismaClient: db as never,
      availabilityChecker: async () => ({ available: true, reason: null }) as never,
      pricingCalculator: async () =>
        ({
          currency: "usd",
          nights: 6,
          nightlySubtotal: 600,
          cleaningFee: 100,
          amenitiesTotal: 0,
          taxesTotal: 70,
          totalAmount: 770,
        }) as never,
    }
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.pagination.total, totalCandidates);
  assert.equal(result.results.length, 50);
  assert.ok(candidateCalls >= 3, "candidate discovery must fetch multiple batches");
});

test("availability and pricing work are concurrency bounded", async () => {
  const totalCandidates = 24;
  const candidates = Array.from({ length: totalCandidates }, (_, index) => ({
    id: `bounded-${index + 1}`,
    name: `California Stay ${index + 1}`,
    slug: `bounded-${index + 1}`,
    publicTitle: null,
    publicPhotos: null,
    maxGuests: 4,
    minimumNights: 1,
    maximumNights: null,
    city: "San Diego",
    region: "California",
    country: "USA",
    timezone: "America/Los_Angeles",
    checkInTime: "16:00",
    checkOutTime: "11:00",
    listingDetails: null,
    amenities: [],
    organization: { slug: "test-org" },
  }));

  const db = {
    property: {
      async findMany(args: any) {
        const cursorId = args.cursor?.id as string | undefined;
        const start = cursorId
          ? candidates.findIndex((item) => item.id === cursorId) + (args.skip ?? 0)
          : 0;
        return candidates.slice(start, start + args.take);
      },
    },
    propertyReview: {
      async groupBy() {
        return [];
      },
    },
  };

  let availabilityActive = 0;
  let availabilityPeak = 0;
  let pricingActive = 0;
  let pricingPeak = 0;

  const wait = () => new Promise((resolve) => setTimeout(resolve, 2));

  const result = await searchPublicStays(
    {
      ...FUTURE_STAY,
      destination: "California",
      pageSize: 50,
    },
    {
      prismaClient: db as never,
      availabilityChecker: async () => {
        availabilityActive += 1;
        availabilityPeak = Math.max(availabilityPeak, availabilityActive);
        await wait();
        availabilityActive -= 1;
        return { available: true, reason: null } as never;
      },
      pricingCalculator: async () => {
        pricingActive += 1;
        pricingPeak = Math.max(pricingPeak, pricingActive);
        await wait();
        pricingActive -= 1;
        return {
          currency: "usd",
          nights: 6,
          nightlySubtotal: 600,
          cleaningFee: 100,
          amenitiesTotal: 0,
          taxesTotal: 70,
          totalAmount: 770,
        } as never;
      },
    }
  );

  assert.equal(result.ok, true);
  assert.ok(availabilityPeak <= 8);
  assert.ok(pricingPeak <= 8);
  assert.ok(availabilityPeak > 1);
  assert.ok(pricingPeak > 1);
});
