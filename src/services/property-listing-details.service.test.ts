import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePropertyListingDetailsInput,
  PropertyListingDetailsValidationError,
} from "./property-listing-details.service";

function invalid(input: unknown, expected: string) {
  assert.throws(
    () => normalizePropertyListingDetailsInput(input),
    (error: unknown) =>
      error instanceof PropertyListingDetailsValidationError &&
      error.issues.some((issue) => issue.includes(expected))
  );
}

test("defaults unconfirmed facts to UNKNOWN without inventing listing facts", () => {
  const value = normalizePropertyListingDetailsInput({});
  assert.equal(value.childrenPolicy, "UNKNOWN");
  assert.equal(value.petsPolicy, "UNKNOWN");
  assert.equal(value.smokeDetector, "UNKNOWN");
  assert.equal(value.minimumPrimaryBookingGuestAge, null);
  assert.deepEqual(value.sleepingAreas, []);
});

test("accepts a 21+ primary booking guest rule independently from children policy", () => {
  const value = normalizePropertyListingDetailsInput({
    minimumPrimaryBookingGuestAge: 21,
    childrenPolicy: "ALLOWED",
    adultsOnly: "NO",
  });
  assert.equal(value.minimumPrimaryBookingGuestAge, 21);
  assert.equal(value.childrenPolicy, "ALLOWED");
});

test("rejects children allowed when Adults Only is confirmed", () => {
  invalid({ adultsOnly: "YES", childrenPolicy: "ALLOWED" }, "children cannot be ALLOWED");
});

test("requires both quiet-hours times when quiet hours are enabled", () => {
  invalid({ quietHoursEnabled: "YES", quietHoursStart: "22:00" }, "quiet-hours start and end");
});

test("rejects parking details unless parking is confirmed", () => {
  invalid({ parkingAvailability: "NO", parkingType: "GARAGE" }, "parking details require");
});

test("requires a disclosure when exterior cameras are confirmed", () => {
  invalid({ exteriorSecurityCameras: "YES" }, "camera disclosure is required");
});

test("requires a disclosure when animals on property are confirmed", () => {
  invalid({ animalsOnProperty: "YES" }, "animal disclosure is required");
});

test("rejects positive entrance steps when entrance is confirmed step-free", () => {
  invalid({ stepFreeEntrance: "YES", entranceStepCount: 2 }, "step-free entrance");
});

test("validates bedroom count against supplied bedroom sleeping areas", () => {
  invalid({
    bedroomCount: 2,
    sleepingAreas: [
      { kind: "BEDROOM", beds: [{ type: "QUEEN", quantity: 1 }] },
    ],
  }, "bedroomCount must match");
});

test("supports bedrooms plus a non-bedroom sleeping area without inflating bedroom count", () => {
  const value = normalizePropertyListingDetailsInput({
    bedroomCount: 1,
    sleepingAreas: [
      { kind: "BEDROOM", nameEn: "Bedroom 1", beds: [{ type: "QUEEN", quantity: 1 }] },
      { kind: "SLEEPING_AREA", nameEn: "Living room", beds: [{ type: "SOFA_BED", quantity: 1 }] },
    ],
  });
  assert.equal(value.bedroomCount, 1);
  assert.equal(value.sleepingAreas.length, 2);
});

test("rejects an empty additional consideration", () => {
  invalid({ additionalConsiderations: [{}] }, "consideration requires");
});


test("accepts canonical property type and discovery features", () => {
  const normalized = normalizePropertyListingDetailsInput({
    propertyType: "CABIN",
    features: [
      { type: "WOOD_CONSTRUCTION", isActive: true, sortOrder: 0 },
      { type: "OCEAN_VIEW", labelEn: "Ocean view", labelEs: "Vista al mar", isActive: true, sortOrder: 1 },
      { type: "GYM", isActive: true, sortOrder: 2 },
    ],
  });

  assert.equal(normalized.propertyType, "CABIN");
  assert.deepEqual(normalized.features.map((feature) => feature.type), [
    "WOOD_CONSTRUCTION",
    "OCEAN_VIEW",
    "GYM",
  ]);
});

test("rejects unknown discovery taxonomy values", () => {
  invalid({ propertyType: "WOODEN_CABIN" }, "propertyType");
  invalid({ features: [{ type: "ROMANTIC" }] }, "features");
});

test("rejects duplicate canonical feature types", () => {
  invalid(
    { features: [{ type: "GYM" }, { type: "GYM" }] },
    "feature types must be unique"
  );
});
