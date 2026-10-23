import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { initialPublicStays, renderPublicStayHtml } from "./services/public-stay-html";

test("initial HTML exposes booking links and location without JavaScript, safely", async () => {
  const template = await readFile(new URL("./booking-search.preview.html", import.meta.url), "utf8");
  const html = renderPublicStayHtml(template, [{ title: '<script>alert("x")</script> $&', bookingPath: "/book/serena-studio/palmasdelmar", city: "Humacao", region: "Puerto Rico", maxGuests: 4, photoUrl: 'https://example.com/photo.jpg" onerror="x' }]);
  const body = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  assert.match(body, /href="https:\/\/pin-ngo.com\/book\/serena-studio\/palmasdelmar"/);
  assert.match(body, /Humacao, Puerto Rico/);
  assert.match(body, /Hasta 4 huéspedes/);
  assert.match(body, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; \$&amp;/);
  assert.doesNotMatch(body, /" onerror="x/);
  assert.equal((body.match(/class="card"/g) || []).length, 1);
  assert.ok(html.includes("applyLanguage();load();"), "interactive search remains enabled");
  const invalid = renderPublicStayHtml(template, [{ title: "private", bookingPath: "/booking/manage/token" }]);
  assert.ok(!invalid.includes('href="https://pin-ngo.com/booking/manage/token"'));
});

test("initial catalog failure or timeout preserves the search page", async () => {
  assert.deepEqual(await initialPublicStays(async () => { throw new Error("unavailable"); }), []);
  assert.deepEqual(await initialPublicStays(() => new Promise(() => {}), 5), []);
  assert.deepEqual(await initialPublicStays(async () => ["public"]), ["public"]);
});

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


test("canonical search redirect preserves query strings and leaves APIs and previews alone", () => {
  const middleware = source.match(/app\.use\(\(req, res, next\) => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(middleware);
  let handler: any;
  runInNewContext(middleware, { app: { use: (fn: any) => { handler = fn; } } });
  for (const method of ["GET", "HEAD"]) {
    handler({ method, hostname: "stays.pin-ngo.com", path: "/", originalUrl: "/?lang=es&utm_source=test" },
      { redirect: (code: number, url: string) => { assert.equal(code, 308); assert.equal(url, "https://book.pin-ngo.com/?lang=es&utm_source=test"); } },
      () => assert.fail("expected redirect"));
  }
  for (const [hostname, path, method] of [["stays.pin-ngo.com", "/api/public-booking/search", "GET"], ["preview.test", "/", "GET"], ["book.pin-ngo.com", "/", "GET"], ["stays.pin-ngo.com", "/", "POST"]]) {
    let next = false;
    handler({ method, hostname, path }, { redirect: () => assert.fail("unexpected redirect") }, () => { next = true; });
    assert.equal(next, true);
  }
});
