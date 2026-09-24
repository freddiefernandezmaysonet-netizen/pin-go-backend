import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("./booking-search.staging.server.ts", import.meta.url),
  "utf8"
);

test("public booking search forwards V2 faceted discovery filters", () => {
  assert.match(source, /minTotalPrice:\s*optionalQueryNumber\(req\.query\.minTotalPrice\)/);
  assert.match(source, /maxTotalPrice:\s*optionalQueryNumber\(req\.query\.maxTotalPrice\)/);
  assert.match(source, /minRating:\s*optionalQueryNumber\(req\.query\.minRating\)/);
  assert.match(source, /minReviewCount:\s*optionalQueryNumber\(req\.query\.minReviewCount\)/);
  assert.match(source, /amenities:\s*queryStringList\(req\.query\.amenities\)/);
  assert.match(source, /accommodationTypes:\s*queryStringList\(req\.query\.accommodationTypes\)/);
  assert.match(source, /propertyTypes:\s*queryStringList\(req\.query\.propertyTypes\)/);
  assert.match(source, /features:\s*queryStringList\(req\.query\.features\)/);
  assert.match(source, /bedTypes:\s*queryStringList\(req\.query\.bedTypes\)/);
  assert.match(source, /minBedrooms:\s*optionalQueryNumber\(req\.query\.minBedrooms\)/);
  assert.match(source, /minBathrooms:\s*optionalQueryNumber\(req\.query\.minBathrooms\)/);
  assert.match(source, /sort:\s*req\.query\.sort/);
  assert.match(source, /page:\s*optionalQueryNumber\(req\.query\.page\)/);
  assert.match(source, /pageSize:\s*optionalQueryNumber\(req\.query\.pageSize\)/);
});

test("amenity query parser accepts repeated and comma-separated values", () => {
  assert.match(
    source,
    /const raw = Array\.isArray\(value\) \? value : value == null \? \[\] : \[value\]/
  );
  assert.match(source, /String\(item\)\.split\(","\)/);
});

test("faceted discovery remains read-only and uses the existing search service", () => {
  const routeStart = source.indexOf('app.get("/api/public-booking/search"');
  const routeEnd = source.indexOf("\napp.listen(", routeStart);
  const route = source.slice(routeStart, routeEnd);

  assert.ok(routeStart >= 0, "search route must exist");
  assert.match(route, /searchPublicStays\(\{/);
  assert.doesNotMatch(route, /\.(create|update|delete|upsert)\(/);
  assert.doesNotMatch(route, /prisma\.\$executeRaw/);
});
