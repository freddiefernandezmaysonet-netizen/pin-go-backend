import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  new URL("./public-booking.routes.ts", import.meta.url),
  "utf8"
);

const detailRoute = source.slice(
  source.indexOf('publicBookingRouter.get("/:organizationSlug/:propertySlug"'),
  source.indexOf('publicBookingRouter.post("/blocked-dates"')
);

test("public property detail selects canonical listing details", () => {
  assert.match(detailRoute, /listingDetails:\s*\{[\s\S]*minimumPrimaryBookingGuestAge: true/);
  assert.match(detailRoute, /bedroomCount: true/);
  assert.match(detailRoute, /fullBathroomCount: true/);
  assert.match(detailRoute, /halfBathroomCount: true/);
  assert.match(detailRoute, /sleepingAreas:[\s\S]*beds:[\s\S]*type: true[\s\S]*quantity: true/);
});

test("public listing details expose guest-relevant policies and practical facts", () => {
  for (const field of [
    "childrenPolicy",
    "infantsPolicy",
    "adultsOnly",
    "petsPolicy",
    "smokingPolicy",
    "vapingPolicy",
    "eventsPolicy",
    "quietHoursEnabled",
    "parkingAvailability",
    "smokeDetector",
    "carbonMonoxideDetector",
    "exteriorSecurityCameras",
    "animalsOnProperty",
    "stepFreeEntrance",
  ]) {
    assert.match(detailRoute, new RegExp(`${field}: true`));
  }
});

test("inactive safety and additional considerations are excluded publicly", () => {
  assert.match(
    detailRoute,
    /safetyConsiderations:\s*\{[\s\S]*where: \{ isActive: true \}/
  );
  assert.match(
    detailRoute,
    /additionalConsiderations:\s*\{[\s\S]*where: \{ isActive: true \}/
  );
});

test("nested public projection omits database identifiers and timestamps", () => {
  const listingStart = detailRoute.indexOf("listingDetails:");
  const listingEnd = detailRoute.indexOf("\n       taxes:", listingStart);
  const listingProjection = detailRoute.slice(listingStart, listingEnd);
  assert.ok(listingProjection.length > 0);
  assert.doesNotMatch(listingProjection, /\bid: true\b/);
  assert.doesNotMatch(listingProjection, /listingDetailsId: true/);
  assert.doesNotMatch(listingProjection, /sleepingAreaId: true/);
  assert.doesNotMatch(listingProjection, /createdAt: true/);
  assert.doesNotMatch(listingProjection, /updatedAt: true/);
});


test("public property detail exposes guest-safe discovery facts", () => {
  assert.match(detailRoute, /propertyType: true/);
  assert.match(detailRoute, /features:\s*\{[\s\S]*where: \{ isActive: true \}[\s\S]*type: true[\s\S]*labelEn: true[\s\S]*labelEs: true[\s\S]*sortOrder: true/);
});

test("experience tags remain discovery metadata and are not automatically public", () => {
  const listingStart = detailRoute.indexOf("listingDetails:");
  const listingEnd = detailRoute.indexOf("\n       taxes:", listingStart);
  const listingProjection = detailRoute.slice(listingStart, listingEnd);
  assert.doesNotMatch(listingProjection, /experienceTags:/);
});
