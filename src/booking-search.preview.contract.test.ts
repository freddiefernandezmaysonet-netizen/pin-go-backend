import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(
  new URL("./booking-search.preview.html", import.meta.url),
  "utf8"
);

test("booking preview exposes faceted discovery controls in both languages", () => {
  for (const id of [
    "filterToggle",
    "filterPanel",
    "minPrice",
    "maxPrice",
    "minRating",
    "accommodationType",
    "bedType",
    "minBedrooms",
    "minBathrooms",
    "sort",
    "amenityFilters",
    "filterApply",
    "filterReset",
    "clearFilters",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }

  assert.match(html, /Precio total máximo/);
  assert.match(html, /Maximum stay total/);
  assert.match(html, /Mesa de billar/);
  assert.match(html, /Ocean view/);
});

test("filter UI forwards supported V2 query parameters only after a valid stay search", () => {
  assert.match(html, /q\.minTotalPrice=\$\('minPrice'\)\.value/);
  assert.match(html, /q\.maxTotalPrice=\$\('maxPrice'\)\.value/);
  assert.match(html, /q\.minRating=\$\('minRating'\)\.value/);
  assert.match(html, /q\.accommodationTypes=\$\('accommodationType'\)\.value/);
  assert.match(html, /q\.bedTypes=\$\('bedType'\)\.value/);
  assert.match(html, /q\.minBedrooms=\$\('minBedrooms'\)\.value/);
  assert.match(html, /q\.minBathrooms=\$\('minBathrooms'\)\.value/);
  assert.match(html, /q\.sort=\$\('sort'\)\.value/);
  assert.match(html, /q\.amenities=amenities\.join\(','\)/);
  assert.match(html, /base\.destination&&base\.checkIn&&base\.checkOut/);
});

test("result cards surface canonical total stay price and reputation evidence", () => {
  assert.match(html, /p\.pricing&&Number\.isFinite\(Number\(p\.pricing\.totalAmount\)\)/);
  assert.match(html, /p\.averageRating/);
  assert.match(html, /p\.reviewCount/);
  assert.match(html, /p\.matchedAmenities/);
});
