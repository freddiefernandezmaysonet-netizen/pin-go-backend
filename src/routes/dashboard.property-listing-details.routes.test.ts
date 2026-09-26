import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const routeSource = fs.readFileSync(
  path.resolve("src/routes/dashboard.property-listing-details.routes.ts"),
  "utf8"
);
const serverSource = fs.readFileSync(path.resolve("src/server.ts"), "utf8");

test("listing-details API exposes authenticated GET and PUT routes", () => {
  assert.match(routeSource, /router\.get\([\s\S]*"\/api\/dashboard\/properties\/:id\/listing-details"[\s\S]*requireAuth/);
  assert.match(routeSource, /router\.put\([\s\S]*"\/api\/dashboard\/properties\/:id\/listing-details"[\s\S]*requireAuth/);
});

test("listing-details writes are tenant-scoped and transactional", () => {
  assert.match(routeSource, /organizationId: orgId/);
  assert.match(routeSource, /prisma\.\$transaction/);
  assert.match(routeSource, /version: \{ increment: 1 \}/);
});

test("server registers the dedicated listing-details router", () => {
  assert.match(serverSource, /buildDashboardPropertyListingDetailsRouter/);
  assert.match(serverSource, /app\.use\(buildDashboardPropertyListingDetailsRouter\(prisma\)\)/);
});


test("listing-details GET includes active discovery features", () => {
  assert.match(routeSource, /features:\s*\{[\s\S]*where:\s*\{\s*isActive:\s*true\s*\}[\s\S]*orderBy:\s*\{\s*sortOrder:\s*"asc"/);
});

test("listing-details PUT replaces discovery features transactionally", () => {
  assert.match(routeSource, /propertyListingFeature\.deleteMany\([\s\S]*listingDetailsId:\s*details\.id/);
  assert.match(routeSource, /propertyListingFeature\.createMany\([\s\S]*features\.map/);
});


test("listing-details GET includes active experience tags", () => {
  assert.match(routeSource, /experienceTags:\s*\{[\s\S]*where:\s*\{\s*isActive:\s*true\s*\}[\s\S]*orderBy:\s*\{\s*sortOrder:\s*"asc"/);
});

test("listing-details PUT replaces experience tags transactionally", () => {
  assert.match(routeSource, /propertyListingExperienceTag\.deleteMany\([\s\S]*listingDetailsId:\s*details\.id/);
  assert.match(routeSource, /propertyListingExperienceTag\.createMany\([\s\S]*experienceTags\.map/);
});
