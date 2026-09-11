import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(path: string): string {
  return fs.readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("Property stores postalCode as optional text and migration preserves leading zeroes", () => {
  const schema = read("prisma/schema.prisma");
  const migration = read(
    "prisma/migrations/20260911143000_add_property_postal_code/migration.sql"
  );

  assert.match(schema, /\bpostalCode\s+String\?/);
  assert.match(
    migration,
    /ALTER TABLE "Property" ADD COLUMN "postalCode" TEXT;/
  );
  assert.equal(migration.includes("INTEGER"), false);
});

test("property create edit and dashboard read contracts carry postalCode", () => {
  const propertiesRoute = read("src/routes/properties.route.ts");
  const dashboardRoute = read("src/routes/dashboard.properties.route.ts");

  assert.match(propertiesRoute, /postalCode:\s*p\.postalCode\s*\?\?\s*""/);
  assert.match(propertiesRoute, /postalCode:\s*postalCode\?\.trim\(\)\s*\|\|\s*null/);
  assert.match(
    propertiesRoute,
    /postalCode !== undefined\s*\?\s*\{\s*postalCode:\s*postalCode\?\.trim\(\)\s*\|\|\s*null\s*\}\s*:\s*\{\}/
  );

  assert.match(dashboardRoute, /postalCode:\s*true/);
  assert.match(dashboardRoute, /postalCode !== undefined[\s\S]*data\.postalCode/);
});

test("postalCode is matching metadata and is not an ARI pricing/restrictions trigger", () => {
  const dashboardRoute = read("src/routes/dashboard.properties.route.ts");
  const start = dashboardRoute.indexOf("const PROPERTY_ARI_BOOLEAN_FIELDS");
  const end = dashboardRoute.indexOf("function toComparablePropertyNumber");
  assert.ok(start >= 0 && end > start);
  const ariFieldConfiguration = dashboardRoute.slice(start, end);
  assert.equal(ariFieldConfiguration.includes("postalCode"), false);
});
