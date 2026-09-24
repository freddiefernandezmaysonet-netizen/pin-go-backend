import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePublicStaySearchText,
  parsePublicStayDateKey,
  validatePublicStaySearchInput,
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
